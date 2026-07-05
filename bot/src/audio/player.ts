import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { accessSync, chmodSync, constants, rmSync } from "node:fs";
import { createOpusEncoder, PCM_FRAME_BYTES, type Encoder } from "./encoder.js";
import type { Logger } from "../logger.js";

const require = createRequire(import.meta.url);
const ffmpegPath: string | null = require("ffmpeg-static");

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
  if (ffmpegPath && (onWindows === isWinPath)) {
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

export function buildFfmpegArgs(url: string, seekSeconds: number): string[] {
  const args: string[] = [];
  const isHttp = /^https?:\/\//i.test(url);

  if (isHttp) {
    args.push(
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "30",
      "-reconnect_on_network_error", "1",
      "-reconnect_on_http_error", "4xx,5xx",
    );
  }
  if (seekSeconds > 0) args.push("-ss", String(seekSeconds));
  args.push("-i", url, "-f", "s16le", "-ar", "48000", "-ac", "2", "-acodec", "pcm_s16le", "-");

  return args;
}

export interface PlayerEvents {
  frame: (opusFrame: Buffer) => void;
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
  private pcmBuffer: Buffer = Buffer.alloc(0);
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
  private currentSongDuration = 0; // total duration of the current song (seconds)

  constructor(logger: Logger) {
    super();
    this.encoder = createOpusEncoder();
    this.logger = logger;
  }

  play(url: string, seekSeconds = 0, songDuration = 0, opts?: { volumePctFloor?: number }): void {
    // 1. Stop all current playback; bump sessionId to invalidate stale callbacks.
    this.stop();
    // Per-play volume floor (radio speech): spoken audio must not ride the
    // music fader into inaudibility — effective volume is max(slider, floor)
    // for THIS playback only; cleared by stop()/the next play().
    this.playVolumeFloor = opts?.volumePctFloor ?? null;

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

    const args = buildFfmpegArgs(url, seekSeconds);

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
      
      this.pcmBuffer = Buffer.concat([this.pcmBuffer, chunk]);
      if (this.pcmBuffer.length > AudioPlayer.BUFFER_HIGH_WATER && !this.ffmpegPaused && this.ffmpeg?.stdout) {
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
    this.pcmBuffer = Buffer.alloc(0);

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
      try { ps.kill("SIGTERM"); } catch { /* already gone */ }
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
    } catch (e) { /* ignore */ }

    const killTimeout = setTimeout(() => {
      try {
        process.kill(pid, 0); 
        process.kill(pid, "SIGKILL");
      } catch (e) {
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

      // Detect a stall where pcmBuffer stays below PCM_FRAME_BYTES and the loop spins:
      //   Cond 1: FFmpeg still running but buffer holds less than one frame, and data
      //           has been unavailable for many consecutive iterations.
      //   Cond 2: playback time is near the end of the song (last 5s) or duration unknown.
      const elapsed = this.getElapsed();
      const isNearEnd = this.currentSongDuration > 0
        ? (this.currentSongDuration - elapsed) <= 5 // less than 5s from the end
        : true; // be conservative when duration is unknown
      
      if (this.ffmpeg !== null && this.pcmBuffer.length < PCM_FRAME_BYTES) {
        this.emptyFrameAttempts++;
        
        // Only treat playback as finished when BOTH hold: empty-frame threshold reached AND near the end.
        if (this.emptyFrameAttempts >= AudioPlayer.MAX_EMPTY_ATTEMPTS && isNearEnd) {
          this.logger.info({ 
            sessionId: this.sessionId,
            emptyAttempts: this.emptyFrameAttempts,
            bufferSize: this.pcmBuffer.length,
            elapsed: Math.round(elapsed),
            duration: this.currentSongDuration,
            remaining: Math.round(this.currentSongDuration - elapsed)
          }, "FFmpeg stopped outputting data near end, ending track");
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

      if (!this.ffmpeg && this.pcmBuffer.length < PCM_FRAME_BYTES) {
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

  private sendNextFrame(): void {
    if (this.pcmBuffer.length < PCM_FRAME_BYTES) return;
    const pcmFrame = this.pcmBuffer.subarray(0, PCM_FRAME_BYTES);
    this.pcmBuffer = this.pcmBuffer.subarray(PCM_FRAME_BYTES);

    if (this.ffmpegPaused && this.pcmBuffer.length < AudioPlayer.BUFFER_LOW_WATER && this.ffmpeg?.stdout) {
      this.ffmpeg.stdout.resume();
      this.ffmpegPaused = false;
    }

    try {
      const adjusted = this.applyVolume(pcmFrame);
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
    const base = Math.max(this.volume, this.playVolumeFloor ?? 0);
    const effectiveVolume = this.sttDuckActive ? this.sttDuckLevel : base;
    if (effectiveVolume === 100) return Buffer.from(pcm);
    const factor = (effectiveVolume / 100) * 0.2;
    const out = Buffer.alloc(pcm.length);
    for (let i = 0; i < pcm.length; i += 2) {
      let sample = Math.round(pcm.readInt16LE(i) * factor);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i);
    }
    return out;
  }

  getElapsed(): number { return this.seekOffset + (this.framesPlayed * FRAME_DURATION_MS) / 1000; }
  seek(seconds: number): void { 
    if (this.currentUrl && Number.isFinite(seconds) && seconds >= 0) {
      this.play(this.currentUrl, seconds, this.currentSongDuration);
    }
  }
  pause(): void { if (this.state === "playing") this.state = "paused"; }
  resume(): void { if (this.state === "paused") { this.state = "playing"; this.nextFrameTime = performance.now(); } }
  resetFailures(): void { this.consecutiveFailures = 0; }
  setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(100, vol));
  }
  getVolume(): number { return this.volume; }

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

  getState(): PlayerState { return this.state; }
}