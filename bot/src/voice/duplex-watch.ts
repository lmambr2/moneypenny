/**
 * Duplex Talker watch-state (docs/personaplex-full-harness.md K4).
 * Pure reducer — no WebSocket. VoiceSession (D2) drives PCM; this owns crash vs
 * sticky RTF fallback so unload `ok=true, loaded=false` cannot auto-warm().
 */

export const RTF_REALTIME = 1.15;
export const FALLBACK_HOLD_MS = 8000;
export const TALKER_VRAM_IDLE_MB = 256;
export const UNLOAD_TIMEOUT_MS = 15_000;

export type DuplexWatchKind = "idle" | "armed-duplex" | "fallback-cascaded" | "fallback-rtf";

export type DuplexEngine = "mock" | "moshi-cuda" | "moshicpp-vulkan" | string;

export interface DuplexHealth {
  ok: boolean;
  loaded?: boolean;
  engine?: DuplexEngine;
  realtime?: boolean;
  rtf?: number;
  /** Talker-process allocator only. Never card-total. */
  vram_mb?: number;
  voice?: string;
  sample_rate?: number;
  frame_hz?: number;
}

export type DuplexWatchAction = "warm" | "unload" | "mute_out";

export interface DuplexWatchTick {
  state: DuplexWatchKind;
  actions: DuplexWatchAction[];
}

export function parseDuplexHealth(raw: unknown): DuplexHealth {
  if (!raw || typeof raw !== "object") return { ok: false };
  const o = raw as Record<string, unknown>;
  const ok = o.ok === true;
  const health: DuplexHealth = { ok };
  if (typeof o.loaded === "boolean") health.loaded = o.loaded;
  if (typeof o.engine === "string") health.engine = o.engine;
  if (typeof o.realtime === "boolean") health.realtime = o.realtime;
  if (typeof o.rtf === "number" && Number.isFinite(o.rtf)) health.rtf = o.rtf;
  if (typeof o.vram_mb === "number" && Number.isFinite(o.vram_mb)) health.vram_mb = o.vram_mb;
  if (typeof o.voice === "string") health.voice = o.voice;
  if (typeof o.sample_rate === "number") health.sample_rate = o.sample_rate;
  if (typeof o.frame_hz === "number") health.frame_hz = o.frame_hz;
  return health;
}

export function healthUnreachable(): DuplexHealth {
  return { ok: false };
}

/** Product /health enum. Experimental onnx-* engines are not in this list. */
export function isProductDuplexEngine(engine: string | undefined): boolean {
  return engine === "mock" || engine === "moshi-cuda" || engine === "moshicpp-vulkan";
}

export class DuplexWatch {
  state: DuplexWatchKind = "idle";
  /** Wall time when loaded=true && realtime=false started. Null if not in a hold. */
  rtfBadSinceMs: number | null = null;

  applyHealth(health: DuplexHealth, nowMs: number): DuplexWatchTick {
    const actions: DuplexWatchAction[] = [];

    if (!health.ok) {
      this.rtfBadSinceMs = null;
      if (this.state !== "fallback-cascaded") {
        if (health.loaded === true) {
          actions.push("mute_out", "unload");
        }
        this.state = "fallback-cascaded";
      }
      return { state: this.state, actions };
    }

    // Crash path recovered: adapter reachable again. Do not warm() — next watchword does.
    if (this.state === "fallback-cascaded") {
      this.rtfBadSinceMs = null;
      this.state = "idle";
      return { state: this.state, actions };
    }

    // Sticky RTF fallback: post-unload ok=true loaded=false is NOT recovery.
    if (this.state === "fallback-rtf") {
      this.rtfBadSinceMs = null;
      return { state: this.state, actions };
    }

    const loaded = health.loaded === true;
    const realtime = health.realtime === true;

    if (loaded && !realtime) {
      if (this.rtfBadSinceMs === null) this.rtfBadSinceMs = nowMs;
      if (nowMs - this.rtfBadSinceMs >= FALLBACK_HOLD_MS) {
        this.state = "fallback-rtf";
        this.rtfBadSinceMs = null;
        actions.push("mute_out", "unload");
        return { state: this.state, actions };
      }
    } else {
      this.rtfBadSinceMs = null;
    }

    return { state: this.state, actions };
  }

  /**
   * Idle watchword match. Warm only when weights are down. Skip-LLM on the
   * remainder is the caller's job and must not wait on warm().
   */
  onWatchword(loaded: boolean): DuplexWatchTick {
    const actions: DuplexWatchAction[] = [];
    if (this.state === "fallback-rtf") {
      return { state: this.state, actions };
    }
    if (this.state === "fallback-cascaded") {
      return { state: this.state, actions };
    }
    if (!loaded) actions.push("warm");
    this.state = "armed-duplex";
    return { state: this.state, actions };
  }

  onListenExpired(): DuplexWatchTick {
    if (this.state === "armed-duplex") this.state = "idle";
    return { state: this.state, actions: [] };
  }

  /** Empty channel: stay idle, drop Talker weights. Not fallback. */
  onEmptyChannel(loaded: boolean): DuplexWatchTick {
    const actions: DuplexWatchAction[] = [];
    if (this.state === "fallback-rtf" || this.state === "fallback-cascaded") {
      return { state: this.state, actions };
    }
    this.state = "idle";
    if (loaded) actions.push("mute_out", "unload");
    return { state: this.state, actions };
  }

  /** Operator sets voice.mode=duplex — only exit from sticky RTF fallback. */
  onOperatorSetDuplex(): DuplexWatchTick {
    if (this.state === "fallback-rtf") this.state = "idle";
    return { state: this.state, actions: [] };
  }
}
