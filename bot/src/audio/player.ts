import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { accessSync, chmodSync, constants, rmSync } from "node:fs";
import { createRequire } from "node:module";
import type { Logger } from "../logger.js";
import { createOpusEncoder, type Encoder, PCM_FRAME_BYTES } from "./encoder.js";

const require = createRequire(import.meta.url);
/** Optional dep — prefer system ffmpeg on the Pi; ffmpeg-static is a large fallback. */
const ffmpegPath: string | null = (() => {
  try {
    return require("ffmpeg-static") as string;
  } catch {
    return null;
  }
})();

/** Global PID tracker — prevents processes from being orphaned when class instances are swapped. */
const globalActivePids = new Set<number>();

function isExecutable(binPath: string): boolean {
  try {
    accessSync(binPath, constants.X_OK);
    return true;
  } catch {
    try {
      chmodSync(binPath, 0o755);
      accessSync(binPath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function ffmpegWorks(bin: string): boolean {
  try {
    execFileSync(bin, ["-version"], { timeout: 5000, stdio: "pipe" }); // arg-array: no shell parsing of the path
    return true;
  } catch {
    return false;
  }
}

const resolvedFfmpeg: string = (() => {
  if (ffmpegWorks("ffmpeg")) return "ffmpeg";
  const isWinPath = ffmpegPath ? /\\/.test(ffmpegPath) || ffmpegPath.endsWith(".exe") : false;
  const onWindows = process.platform === "win32";
  if (ffmpegPath && onWindows === isWinPath) {
    if (isExecutable(ffmpegPath) && ffmpegWorks(ffmpegPath)) return ffmpegPath;
  }
  return "ffmpeg";
})();

export function getFfmpegCommand(): string {
  return resolvedFfmpeg;
}

export function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

export interface BuildFfmpegArgsOpts {
  /**
   * Optional lavfi filter graph applied after decode (e.g. radio "AM" color).
   * Inserted as a single `-af <graph>` before PCM encode.
   */
  audioFilter?: string | null;
}

export function buildFfmpegArgs(
  url: string,
  seekSeconds: number,
  opts?: BuildFfmpegArgsOpts,
): string[] {
  const args: string[] = [];
  const isHttp = /^https?:\/\//i.test(url);

  if (isHttp) {
    args.push(
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "30",
      "-reconnect_on_network_error",
      "1",
      "-reconnect_on_http_error",
      "4xx,5xx",
    );
  }
  if (seekSeconds > 0) args.push("-ss", String(seekSeconds));
  args.push("-i", url);
  const af = typeof opts?.audioFilter === "string" ? opts.audioFilter.trim() : "";
  if (af) {
    // Reject newlines / control chars that could break argv; allow ,=: for lavfi graphs.
    if (!/[\n\r\0]/.test(af) && af.length < 2000) {
      args.push("-af", af);
    }
  }
  args.push("-f", "s16le", "-ar", "48000", "-ac", "2", "-acodec", "pcm_s16le", "-");

  return args;
}

export interface PlayerEvents {
  /** Opus frame for TeamSpeak voice injection. */
  frame: (opusFrame: Buffer) => void;
  /**
   * Volume-adjusted s16le PCM (48k stereo, one Opus frame period) — same buffer
   * that was encoded to `frame`. Used by optional Icecast tee (R-R6).
   */
  pcm: (pcmFrame: Buffer) => void;
  trackEnd: () => void;
  error: (err: Error) => void;
}

export type PlayerState = "idle" | "playing" | "paused";

const FRAME_DURATION_MS = 20;

export class AudioPlayer extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private encoder: Encoder;
  private state: PlayerState = "idle";
  private volume = 30;
  /** Per-play floor (see play() opts); null = slider only. */
  private playVolumeFloor: number | null = null;
  /** Extra attenuation during voice capture — independent of the volume slider. */
  private sttDuckActive = false;
  private sttDuckLevel = 2;
  /** Chunk queue avoids O(n) Buffer.concat on every ffmpeg data event. */
  private pcmChunks: Buffer[] = [];
  private pcmBuffered = 0;
  private logger: Logger;
  private frameLoopRunning = false;
  private nextFrameTime = 0;
  private currentUrl = "";
  private seekOffset = 0;
  private framesPlayed = 0;
  private sessionId = 0;
  private static readonly BUFFER_HIGH_WATER = 640 * 1024;
  private static readonly BUFFER_LOW_WATER = 256 * 1024;
  private ffmpegPaused = false;
  private spawnFailed = false;
  private consecutiveFailures = 0;
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;
  private healthyFrames = 0;
  private static readonly HEALTHY_FRAME_RESET = 50; // ~1 second of audio
  private downloader: ChildProcess | null = null;
  private currentTempDir: string | null = null;
  private emptyFrameAttempts = 0;
  private static readonly MAX_EMPTY_ATTEMPTS = 250; // ~5s of the 20ms frame loop (extra fault tolerance)
  /**
   * Absolute mid-track stall: empty buffer for this many frame ticks while FFmpeg
   * is still "alive" ends the track even when isNearEnd is false (hung CDN /
   * Icecast). ~10s at 20ms ticks. Prevents permanent dead air (audit A1).
   */
  private static readonly MAX_MIDTRACK_STALL_ATTEMPTS = 500;
  private currentSongDuration = 0; // total duration of the current song (seconds)
  /** Speech floor to re-apply across seek() so bumpers stay audible (audit A3). */
  private lastPlayVolumeFloor: number | null = null;
  /**
   * Optional music-only ffmpeg -af graph (radio AM/FM color, etc.).
   * Spoken bumpers (volumePctFloor set) skip this so announcements stay clear.
   */
  private musicAudioFilter: string | null = null;

  constructor(logger: Logger) {
    super();
    this.encoder = createOpusEncoder();
    this.logger = logger;
  }

  /**
   * Set the music color/quality filter (ffmpeg -af). Pass null/empty to clear.
   * Takes effect on the next `play()` of non-speech audio.
   */
  setMusicAudioFilter(filter: string | null | undefined): void {
    const f = typeof filter === "string" ? filter.trim() : "";
    this.musicAudioFilter = f && !/[\n\r\0]/.test(f) && f.length < 2000 ? f : null;
  }

  getMusicAudioFilter(): string | null {
    return this.musicAudioFilter;
  }

  play(url: string, seekSeconds = 0, songDuration = 0, opts?: { volumePctFloor?: number }): void {
    // 1. Stop all current playback; bump sessionId to invalidate stale callbacks.
    this.stop();
    // Per-play volume floor (radio speech): spoken audio must not ride the
    // music fader into inaudibility — effective volume is max(slider, floor)
    // for THIS playback only; cleared by stop()/the next play().
    this.playVolumeFloor = opts?.volumePctFloor ?? null;
    this.lastPlayVolumeFloor = this.playVolumeFloor;

    const currentSessionId = this.sessionId;
    this.currentUrl = url;
    this.seekOffset = seekSeconds;
    this.framesPlayed = 0;
    this.healthyFrames = 0;
    this.ffmpegPaused = false;
    this.spawnFailed = false;
    this.emptyFrameAttempts = 0;
    this.currentSongDuration = songDuration;

    if (this.consecutiveFailures >= AudioPlayer.MAX_CONSECUTIVE_FAILURES) {
      this.logger.error({ failures: this.consecutiveFailures }, "FFmpeg failures limit reached");
      this.state = "idle";
      this.emit("error", new Error("ffmpeg unavailable"));
      return;
    }

    // Speech / bumper plays: keep full band. Music: optional radio color overlay.
    const isSpeech = this.playVolumeFloor != null;
    const af = !isSpeech ? this.musicAudioFilter : null;
    const args = buildFfmpegArgs(url, seekSeconds, { audioFilter: af });

    const ffmpegBin = getFfmpegCommand();
    this.ffmpeg = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });

    const currentPid = this.ffmpeg.pid;
    if (currentPid) {
      globalActivePids.add(currentPid);
      this.logger.debug({ pid: currentPid, sessionId: currentSessionId }, "FFmpeg spawned");
    }

    this.ffmpeg.stdout!.on("data", (chunk: Buffer) => {
      // 2. Strictly check sessionId to keep old-process data out of a new playback request.
      if (this.sessionId !== currentSessionId) {
        return;
      }
      this.pcmChunks.push(chunk);
      this.pcmBuffered += chunk.length;
      if (
        this.pcmBuffered > AudioPlayer.BUFFER_HIGH_WATER &&
        !this.ffmpegPaused &&
        this.ffmpeg?.stdout
      ) {
        this.ffmpeg.stdout.pause();
        this.ffmpegPaused = true;
      }
    });

    this.ffmpeg.on("exit", (code, signal) => {
      if (currentPid) globalActivePids.delete(currentPid);
      this.logger.info({ pid: currentPid, code, signal }, "FFmpeg exited");

      // Only null out the field when the current session's process exits.
      if (this.sessionId === currentSessionId) {
        this.ffmpeg = null;
      }
    });

    this.ffmpeg.on("error", (err) => {
      if (this.sessionId === currentSessionId) {
        this.spawnFailed = true;
        this.consecutiveFailures++;
        this.emit("error", err);
      }
    });

    this.state = "playing";
    this.startFrameLoop();
  }

  stop(): void {
    this.playVolumeFloor = null;
    // 3. Incrementing the ID is the most effective logical "isolation wall".
    this.sessionId++;
    this.frameLoopRunning = false;

    // Clear the buffer immediately so track switches are silent instantly.
    this.pcmChunks = [];
    this.pcmBuffered = 0;

    if (this.ffmpeg) {
      const procToKill = this.ffmpeg;
      const pidToKill = procToKill.pid;
      this.ffmpeg = null;

      if (pidToKill) {
        this.forceCleanup(procToKill, pidToKill);
      }
    }

    if (this.downloader) {
      const ps = this.downloader;
      this.downloader = null;
      try {
        ps.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }

    if (this.currentTempDir) {
      cleanupTempDir(this.currentTempDir);
      this.currentTempDir = null;
    }

    this.ffmpegPaused = false;
    this.spawnFailed = false;
    this.state = "idle";
    this.currentUrl = "";
    this.seekOffset = 0;
    this.framesPlayed = 0;
    this.healthyFrames = 0;
    this.sttDuckActive = false;
  }

  private forceCleanup(proc: ChildProcess, pid: number): void {
    if (!globalActivePids.has(pid)) return;

    try {
      proc.kill("SIGTERM");
    } catch (_e) {
      /* ignore */
    }

    const killTimeout = setTimeout(() => {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch (_e) {
      } finally {
        globalActivePids.delete(pid);
      }
    }, 1500);

    proc.unref();
    proc.once("exit", () => {
      clearTimeout(killTimeout);
      globalActivePids.delete(pid);
    });
  }

  private startFrameLoop(): void {
    if (this.frameLoopRunning) return;
    this.frameLoopRunning = true;
    this.nextFrameTime = performance.now();
    this.scheduleNextFrame();
  }

  private scheduleNextFrame(): void {
    if (!this.frameLoopRunning) return;
    const loopSessionId = this.sessionId;
    this.nextFrameTime += FRAME_DURATION_MS;
    const delay = Math.max(0, this.nextFrameTime - performance.now());

    setTimeout(() => {
      // This check prevents a stale timer callback from running logic for a new session.
      if (loopSessionId !== this.sessionId || !this.frameLoopRunning) return;

      if (this.state === "playing") this.sendNextFrame();
      else if (this.state === "paused") this.nextFrameTime = performance.now();

      // Detect a stall where pcm stays below PCM_FRAME_BYTES and the loop spins:
      //   Cond 1: FFmpeg still running but buffer holds less than one frame, and data
      //           has been unavailable for many consecutive iterations.
      //   Cond 2: playback is near the end of the song (last 5s). When duration is
      //           unknown, require a minimum elapsed time so slow buffer fill at
      //           start does not look like "track ended" and restart the song.
      const elapsed = this.getElapsed();
      const isNearEnd =
        this.currentSongDuration > 0
          ? this.currentSongDuration - elapsed <= 5 // less than 5s from the end
          : elapsed >= 45; // unknown duration: only after ~45s of wall play time

      if (this.ffmpeg !== null && this.pcmBuffered < PCM_FRAME_BYTES) {
        this.emptyFrameAttempts++;

        const nearEndStall = this.emptyFrameAttempts >= AudioPlayer.MAX_EMPTY_ATTEMPTS && isNearEnd;
        // Mid-track: hung upstream (Icecast/bridge/CDN) never reaches isNearEnd.
        const midTrackStall =
          this.emptyFrameAttempts >= AudioPlayer.MAX_MIDTRACK_STALL_ATTEMPTS && elapsed >= 2;

        if (nearEndStall || midTrackStall) {
          this.logger.info(
            {
              sessionId: this.sessionId,
              emptyAttempts: this.emptyFrameAttempts,
              bufferSize: this.pcmBuffered,
              elapsed: Math.round(elapsed),
              duration: this.currentSongDuration,
              remaining: Math.round(this.currentSongDuration - elapsed),
              reason: midTrackStall && !nearEndStall ? "mid_track_stall" : "near_end_stall",
            },
            midTrackStall && !nearEndStall
              ? "FFmpeg stalled mid-track (no PCM) — ending track"
              : "FFmpeg stopped outputting data near end, ending track",
          );
          this.frameLoopRunning = false;
          if (this.state !== "idle") {
            this.state = "idle";
            // Clean up the FFmpeg process
            if (this.ffmpeg) {
              const procToKill = this.ffmpeg;
              const pidToKill = procToKill.pid;
              this.ffmpeg = null;
              if (pidToKill) {
                this.forceCleanup(procToKill, pidToKill);
              }
            }
            this.consecutiveFailures = 0;
            this.emit("trackEnd");
          }
          return;
        }
      } else {
        // Got data, or FFmpeg has finished — reset the counter.
        this.emptyFrameAttempts = 0;
      }

      if (!this.ffmpeg && this.pcmBuffered < PCM_FRAME_BYTES) {
        this.frameLoopRunning = false;
        if (this.state !== "idle") {
          this.state = "idle";
          if (!this.spawnFailed) {
            this.consecutiveFailures = 0;
            this.emit("trackEnd");
          }
        }
        return;
      }
      this.scheduleNextFrame();
    }, delay);
  }

  /** Drain exactly one Opus-frame of PCM from the chunk list (no full-buffer concat). */
  private takePcmFrame(): Buffer | null {
    if (this.pcmBuffered < PCM_FRAME_BYTES) return null;
    const frame = Buffer.allocUnsafe(PCM_FRAME_BYTES);
    let filled = 0;
    while (filled < PCM_FRAME_BYTES) {
      const head = this.pcmChunks[0];
      if (!head) break;
      const need = PCM_FRAME_BYTES - filled;
      const take = Math.min(need, head.length);
      head.copy(frame, filled, 0, take);
      filled += take;
      if (take === head.length) this.pcmChunks.shift();
      else this.pcmChunks[0] = head.subarray(take);
    }
    this.pcmBuffered -= filled;
    return filled === PCM_FRAME_BYTES ? frame : null;
  }

  private sendNextFrame(): void {
    const pcmFrame = this.takePcmFrame();
    if (!pcmFrame) return;

    if (
      this.ffmpegPaused &&
      this.pcmBuffered < AudioPlayer.BUFFER_LOW_WATER &&
      this.ffmpeg?.stdout
    ) {
      this.ffmpeg.stdout.resume();
      this.ffmpegPaused = false;
    }

    try {
      const adjusted = this.applyVolume(pcmFrame);
      // Tee PCM before Opus so Icecast (and any other sink) gets the same
      // program as TS, volume-adjusted. Listeners must not throw.
      this.emit("pcm", adjusted);
      const opusFrame = this.encoder.encode(adjusted);
      this.emit("frame", opusFrame);
      this.framesPlayed++;
      this.healthyFrames++;
      if (this.healthyFrames >= AudioPlayer.HEALTHY_FRAME_RESET) {
        this.consecutiveFailures = 0;
        this.healthyFrames = 0;
      }
    } catch (err) {
      this.emit("error", err as Error);
    }
  }

  private applyVolume(pcm: Buffer): Buffer {
    const floor = this.playVolumeFloor ?? 0;
    const base = Math.max(this.volume, floor);
    // The courtesy duck (duckMusicOnSpeech) lowers MUSIC while members talk —
    // but a floored playback IS the bot talking (radio bumper/liner), and the
    // announcer doesn't duck for chatter: the floor beats the duck too.
    const effectiveVolume = this.sttDuckActive ? Math.max(this.sttDuckLevel, floor) : base;
    // Historical volume curve multiplies by 0.2 — factor 1.0 never happens at slider≤100.
    const factor = (effectiveVolume / 100) * 0.2;
    if (factor >= 0.999) return pcm;
    const out = Buffer.allocUnsafe(pcm.length);
    if (pcm.byteOffset % 2 === 0 && pcm.length % 2 === 0) {
      const src = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
      const dst = new Int16Array(out.buffer, out.byteOffset, out.length / 2);
      for (let i = 0; i < src.length; i++) {
        const sample = Math.round(src[i] * factor);
        dst[i] = sample < -32768 ? -32768 : sample > 32767 ? 32767 : sample;
      }
      return out;
    }
    for (let i = 0; i < pcm.length; i += 2) {
      const sample = Math.round(pcm.readInt16LE(i) * factor);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i);
    }
    return out;
  }

  getElapsed(): number {
    return this.seekOffset + (this.framesPlayed * FRAME_DURATION_MS) / 1000;
  }
  seek(seconds: number): void {
    if (this.currentUrl && Number.isFinite(seconds) && seconds >= 0) {
      // Preserve speech floor across seek (stop→play would null it otherwise).
      const floor = this.playVolumeFloor ?? this.lastPlayVolumeFloor;
      this.play(
        this.currentUrl,
        seconds,
        this.currentSongDuration,
        floor != null ? { volumePctFloor: floor } : undefined,
      );
    }
  }
  pause(): void {
    if (this.state === "playing") this.state = "paused";
  }
  resume(): void {
    if (this.state === "paused") {
      this.state = "playing";
      this.nextFrameTime = performance.now();
    }
  }
  resetFailures(): void {
    this.consecutiveFailures = 0;
  }
  setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(100, vol));
  }
  getVolume(): number {
    return this.volume;
  }

  /** Attenuate output while voice capture runs; restores on {@link restoreFromSttDuck}. */
  duckForStt(duckLevel: number): boolean {
    if (this.state !== "playing") return false;
    this.sttDuckActive = true;
    this.sttDuckLevel = Math.max(0, Math.min(100, duckLevel));
    return true;
  }

  restoreFromSttDuck(): boolean {
    if (!this.sttDuckActive) return false;
    this.sttDuckActive = false;
    return true;
  }

  isSttDucked(): boolean {
    return this.sttDuckActive;
  }

  getState(): PlayerState {
    return this.state;
  }
}
