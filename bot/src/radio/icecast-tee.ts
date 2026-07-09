/**
 * Optional Icecast tee (docs/radio.md §10 / R-R6).
 *
 * When enabled, a second PCM sink can feed a local Icecast mount via ffmpeg
 * (source protocol). Default off — no process, no network, until configured.
 *
 * This module owns the **contract** (config validation + ffmpeg argv + process
 * lifecycle). Wiring PCM from the TS player is the bot instance's job; tests
 * drive this module with an injectable spawn so we never need a real Icecast.
 */

import type { Logger } from "../logger.js";

export interface IcecastTeeConfig {
  enabled: boolean;
  /** Icecast source URL, e.g. `icecast://source:hackme@127.0.0.1:8000/live` */
  mountUrl: string;
  /** Optional format hint for the sink (default mp3). */
  format?: "mp3" | "ogg" | "opus";
  /** Sample rate of inbound PCM (default 48000 — TeamSpeak path). */
  sampleRate?: number;
  /** Channels of inbound PCM (default 2). */
  channels?: number;
}

export function defaultIcecastTeeConfig(): IcecastTeeConfig {
  return {
    enabled: false,
    mountUrl: "",
    format: "mp3",
    sampleRate: 48000,
    channels: 2,
  };
}

/** Normalize partial Settings / config into a full tee config (defaults off). */
export function resolveIcecastTee(
  partial?: Partial<IcecastTeeConfig> | null,
): IcecastTeeConfig {
  const d = defaultIcecastTeeConfig();
  if (!partial || typeof partial !== "object") return d;
  return {
    enabled: !!partial.enabled,
    mountUrl: typeof partial.mountUrl === "string" ? partial.mountUrl.trim() : "",
    format:
      partial.format === "ogg" || partial.format === "opus" || partial.format === "mp3"
        ? partial.format
        : "mp3",
    sampleRate:
      typeof partial.sampleRate === "number" && partial.sampleRate > 0
        ? partial.sampleRate
        : 48000,
    channels:
      typeof partial.channels === "number" && partial.channels > 0
        ? partial.channels
        : 2,
  };
}

/**
 * True when the tee should run: master switch on + a plausible mount URL.
 * Requires `icecast://` or `http(s)://…` source-style URL (Icecast 2 source).
 */
export function isIcecastTeeReady(cfg: IcecastTeeConfig): boolean {
  if (!cfg.enabled) return false;
  const u = (cfg.mountUrl || "").trim();
  if (!u) return false;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "icecast:") return true;
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      // http(s) source PUT is accepted by many Icecast setups via ffmpeg icecast muxer
      return !!parsed.hostname;
    }
    return false;
  } catch {
    return false;
  }
}

/** Build ffmpeg argv that reads s16le PCM on stdin and pushes to Icecast. */
export function buildIcecastFfmpegArgs(cfg: IcecastTeeConfig): string[] {
  if (!isIcecastTeeReady(cfg)) {
    throw new Error("Icecast tee is not ready (disabled or missing mountUrl)");
  }
  const sr = cfg.sampleRate ?? 48000;
  const ch = cfg.channels ?? 2;
  const fmt = cfg.format ?? "mp3";
  const codec =
    fmt === "ogg" ? ["-c:a", "libvorbis", "-q:a", "5"] :
    fmt === "opus" ? ["-c:a", "libopus", "-b:a", "128k"] :
    ["-c:a", "libmp3lame", "-b:a", "192k"];
  // icecast:// is ffmpeg's native source protocol; http(s) also works with -f icecast
  const outProto = cfg.mountUrl.startsWith("icecast:") ? [] : ["-f", "icecast"];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "s16le",
    "-ar",
    String(sr),
    "-ac",
    String(ch),
    "-i",
    "pipe:0",
    ...codec,
    ...outProto,
    cfg.mountUrl.trim(),
  ];
}

export type SpawnFn = (
  command: string,
  args: string[],
  opts?: { stdio?: unknown },
) => {
  stdin?: { write: (b: Buffer) => boolean; end: () => void } | null;
  killed?: boolean;
  kill: (sig?: string | number) => void | boolean;
  on?: (ev: string, cb: (...a: unknown[]) => void) => void;
};

export interface IcecastTeeDeps {
  logger?: Logger;
  spawn?: SpawnFn;
  ffmpegPath?: string;
}

/**
 * Lifecycle for the optional Icecast source process.
 * `writePcm` is a no-op when not running (fail-open for the music path).
 */
export class IcecastTee {
  private proc: ReturnType<SpawnFn> | null = null;
  private cfg: IcecastTeeConfig = defaultIcecastTeeConfig();

  constructor(private deps: IcecastTeeDeps = {}) {}

  getConfig(): IcecastTeeConfig {
    return this.cfg;
  }

  isRunning(): boolean {
    return !!this.proc && !this.proc.killed;
  }

  /** Hot-apply config; restarts process when ready, stops when not. */
  apply(partial?: Partial<IcecastTeeConfig> | null): { running: boolean; reason?: string } {
    this.cfg = resolveIcecastTee(partial);
    if (!isIcecastTeeReady(this.cfg)) {
      this.stop();
      return {
        running: false,
        reason: this.cfg.enabled ? "mountUrl missing or invalid" : "disabled",
      };
    }
    this.stop();
    return this.start();
  }

  start(): { running: boolean; reason?: string } {
    if (!isIcecastTeeReady(this.cfg)) {
      return { running: false, reason: "not ready" };
    }
    if (this.isRunning()) return { running: true };
    const spawn = this.deps.spawn;
    if (!spawn) {
      this.deps.logger?.warn?.("Icecast tee: no spawn injected — not starting process");
      return { running: false, reason: "no spawn" };
    }
    try {
      const args = buildIcecastFfmpegArgs(this.cfg);
      const bin = this.deps.ffmpegPath || "ffmpeg";
      this.proc = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"] });
      this.proc.on?.("exit", () => {
        this.proc = null;
      });
      this.proc.on?.("error", (err: unknown) => {
        this.deps.logger?.warn?.({ err }, "Icecast tee process error");
        this.proc = null;
      });
      this.deps.logger?.info?.(
        { mount: this.cfg.mountUrl.replace(/:[^:@/]+@/, ":***@") },
        "Icecast tee started",
      );
      return { running: true };
    } catch (err) {
      this.deps.logger?.warn?.({ err }, "Icecast tee failed to start");
      this.proc = null;
      return { running: false, reason: err instanceof Error ? err.message : "start failed" };
    }
  }

  stop(): void {
    if (!this.proc) return;
    try {
      this.proc.stdin?.end();
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.proc = null;
  }

  /** Best-effort PCM tee. Never throws into the player path. */
  writePcm(pcm: Buffer): void {
    if (!this.proc?.stdin) return;
    try {
      this.proc.stdin.write(pcm);
    } catch {
      /* drop on backpressure / closed pipe */
    }
  }

  /** Status for Settings / !radio / health. */
  status(): {
    enabled: boolean;
    ready: boolean;
    running: boolean;
    mountUrl: string;
    format: string;
  } {
    return {
      enabled: this.cfg.enabled,
      ready: isIcecastTeeReady(this.cfg),
      running: this.isRunning(),
      mountUrl: this.cfg.mountUrl
        ? this.cfg.mountUrl.replace(/:[^:@/]+@/, ":***@")
        : "",
      format: this.cfg.format ?? "mp3",
    };
  }
}
