/**
 * Energy-based voice end-pointing (DESIGN §10's "circular-buffer + VAD
 * end-pointing" pattern).
 *
 * Default implementation is a dependency-free RMS-energy segmenter. Production
 * can swap Silero (or another model VAD) via `createVadSegmenter({ backend })`
 * behind the same `VadSegmenter` interface (`push` / `flush`).
 *
 * Operates on 16-bit little-endian PCM. Multi-channel input is treated as
 * interleaved; energy is computed across all samples.
 *
 * PR-B4: RMS prefers Rust N-API `@moneypenny/audio-native` when built.
 */

import { loadNativeAudio } from "../audio/native.js";

export interface SegmenterOptions {
  sampleRate: number;
  channels?: number;
  /** RMS amplitude (0..32768) above which a frame counts as speech. */
  energyThreshold?: number;
  /** Trailing silence that ends an utterance. */
  hangoverMs?: number;
  /** Utterances shorter than this (speech-only) are discarded as blips. */
  minSpeechMs?: number;
  /** Force-emit if a single utterance grows past this. */
  maxUtteranceMs?: number;
}

/** Swappable VAD end-pointer (energy today; Silero factory-ready). */
export interface VadSegmenter {
  /** Feed PCM; returns completed utterance bytes when end-pointed, else null. */
  push(pcm: Buffer): Buffer | null;
  /** Force-emit buffered speech (e.g. speaker left). */
  flush(): Buffer | null;
}

export type VadBackend = "energy" | "silero";

export interface CreateVadOptions extends SegmenterOptions {
  /**
   * `silero` — model VAD (default). Needs `onnxruntime-node` + an ONNX model;
   *           falls back to energy when either is missing.
   * `energy` — RMS SilenceSegmenter (fallback / tests).
   */
  backend?: VadBackend;
  /** Path to silero_vad.onnx. Required for backend=`silero`. */
  modelPath?: string;
  /** Speech probability threshold for the model backend (0..1). */
  speechThreshold?: number;
  /** Optional logger sink for fallback notices. */
  onFallback?: (msg: string) => void;
}

/**
 * Synchronous factory (audit C5). Always returns an end-pointer immediately;
 * `silero` needs an async model load, so use {@link createVadSegmenterAsync}
 * when you want the model backend to actually engage.
 */
export function createVadSegmenter(opts: CreateVadOptions): VadSegmenter {
  if ((opts.backend ?? "silero") === "silero") {
    opts.onFallback?.(
      "Silero VAD needs async init — use createVadSegmenterAsync(); using energy segmenter",
    );
  }
  return new SilenceSegmenter(opts);
}

/**
 * Resolve the configured backend, loading the model when one is requested.
 *
 * Falls back to the energy segmenter — never throws — when the runtime or the
 * model is missing, because losing voice entirely is worse than losing
 * end-pointing quality. Default backend is Silero; energy is the fallback.
 */
export async function createVadSegmenterAsync(opts: CreateVadOptions): Promise<VadSegmenter> {
  const backend = opts.backend ?? "silero";
  if (backend !== "silero") return new SilenceSegmenter(opts);

  const modelPath = opts.modelPath || "";
  if (!modelPath) {
    opts.onFallback?.("Silero VAD selected but no modelPath configured — using energy segmenter");
    return new SilenceSegmenter(opts);
  }

  try {
    const { SileroSegmenter } = await import("./silero.js");
    const seg = new SileroSegmenter({ ...opts, modelPath });
    if (await seg.init()) return seg;
    opts.onFallback?.(
      `Silero VAD unavailable (onnxruntime-node or ${opts.modelPath} missing) — using energy segmenter`,
    );
  } catch (err) {
    opts.onFallback?.(
      `Silero VAD failed to load (${err instanceof Error ? err.message : "unknown"}) — using energy segmenter`,
    );
  }
  return new SilenceSegmenter(opts);
}

/** RMS of s16le PCM. Prefers Rust N-API (PR-B4) when available. */
export function rms16(pcm: Buffer): number {
  const native = loadNativeAudio();
  if (native) {
    try {
      return native.pcmRms(pcm);
    } catch {
      // fall through
    }
  }
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / n);
}

export class SilenceSegmenter implements VadSegmenter {
  private readonly sampleRate: number;
  private readonly channels: number;
  private readonly energyThreshold: number;
  private readonly hangoverMs: number;
  private readonly minSpeechMs: number;
  private readonly maxUtteranceMs: number;

  private chunks: Buffer[] = [];
  private speaking = false;
  private speechMs = 0;
  private silenceMs = 0;
  private bufferedMs = 0;

  constructor(opts: SegmenterOptions) {
    this.sampleRate = opts.sampleRate;
    this.channels = opts.channels ?? 1;
    this.energyThreshold = opts.energyThreshold ?? 500;
    this.hangoverMs = opts.hangoverMs ?? 600;
    this.minSpeechMs = opts.minSpeechMs ?? 250;
    this.maxUtteranceMs = opts.maxUtteranceMs ?? 12_000;
  }

  private frameMs(pcm: Buffer): number {
    const samplesPerChannel = pcm.length / 2 / this.channels;
    return (samplesPerChannel / this.sampleRate) * 1000;
  }

  /**
   * Feed a PCM frame. Returns a completed utterance (PCM) when end-pointed,
   * otherwise null. Pre-speech silence is dropped so utterances start at onset.
   */
  push(pcm: Buffer): Buffer | null {
    if (pcm.length < 2) return null;
    const ms = this.frameMs(pcm);
    const isSpeech = rms16(pcm) >= this.energyThreshold;

    if (isSpeech) {
      this.speaking = true;
      this.silenceMs = 0;
      this.chunks.push(pcm);
      this.speechMs += ms;
      this.bufferedMs += ms;
      // Force-flush an over-long utterance even if the speaker hasn't paused.
      if (this.bufferedMs >= this.maxUtteranceMs) return this.complete();
      return null;
    }

    // Silence.
    if (!this.speaking) return null; // still waiting for onset — drop it
    this.chunks.push(pcm); // keep a little trailing silence for the recognizer
    this.silenceMs += ms;
    this.bufferedMs += ms;
    if (this.silenceMs >= this.hangoverMs) {
      // End of turn. Emit only if enough actual speech was captured.
      if (this.speechMs >= this.minSpeechMs) return this.complete();
      this.reset(); // too short — discard the blip
      return null;
    }
    return null;
  }

  /** Force-emit whatever speech is buffered (e.g. speaker left / disconnect). */
  flush(): Buffer | null {
    if (this.speaking && this.speechMs >= this.minSpeechMs) return this.complete();
    this.reset();
    return null;
  }

  private complete(): Buffer {
    const out = Buffer.concat(this.chunks);
    this.reset();
    return out;
  }

  private reset(): void {
    this.chunks = [];
    this.speaking = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.bufferedMs = 0;
  }
}
