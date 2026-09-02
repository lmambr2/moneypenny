/**
 * Silero VAD end-pointer (audit C5).
 *
 * Implements the same `VadSegmenter` contract as the RMS `SilenceSegmenter`, so
 * it drops into `createVadSegmenterAsync({ backend: "silero" })` with no pipeline
 * change. Silero is the default; energy RMS is fallback when the ONNX model or
 * `onnxruntime-node` is missing.
 *
 * Deliberately NOT a package.json dependency. `onnxruntime-node` is a large
 * native module and this bot's primary target is an RK3588 SBC, so it is
 * imported lazily and any failure falls back to energy rather than breaking
 * voice. Install to enable:
 *
 *   cd bot && npm i onnxruntime-node
 *   ./scripts/download-silero-vad.sh
 *
 * Model: Silero VAD v5 — 16 kHz, 512-sample frames, combined LSTM state.
 */

import type { SegmenterOptions, VadSegmenter } from "./vad.js";

/** Silero v5 operates on 16 kHz mono, 512 samples (32 ms) per inference. */
const SILERO_SAMPLE_RATE = 16_000;
const SILERO_FRAME_SAMPLES = 512;
const SILERO_STATE_DIMS = [2, 1, 128];

export interface SileroOptions extends SegmenterOptions {
  /** Path to silero_vad.onnx. */
  modelPath: string;
  /** Speech probability above which a frame counts as speech (0..1). */
  speechThreshold?: number;
}

/** Minimal shape of the bits of onnxruntime-node used here. */
interface OrtTensorCtor {
  new (type: string, data: Float32Array | BigInt64Array, dims: number[]): unknown;
}
interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
}
interface OrtModule {
  Tensor: OrtTensorCtor;
  InferenceSession: { create(path: string): Promise<OrtSession> };
}

/**
 * Downmix interleaved s16 to mono and decimate 48 kHz -> 16 kHz.
 *
 * Opus already band-limits the signal, and we decimate by an integer factor of
 * 3, so averaging each group of 3 source samples is an adequate anti-alias for
 * a VAD decision. Exported for tests.
 */
export function toMono16k(pcm: Buffer, sampleRate: number, channels: number): Float32Array {
  const frameCount = Math.floor(pcm.length / 2 / channels);
  const mono = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm.readInt16LE((i * channels + c) * 2);
    mono[i] = sum / channels / 32768;
  }

  if (sampleRate === SILERO_SAMPLE_RATE) return mono;

  const ratio = sampleRate / SILERO_SAMPLE_RATE;
  const outLength = Math.floor(mono.length / ratio);
  const out = new Float32Array(outLength);
  if (Number.isInteger(ratio)) {
    const step = ratio;
    for (let i = 0; i < outLength; i++) {
      let sum = 0;
      for (let k = 0; k < step; k++) sum += mono[i * step + k] ?? 0;
      out[i] = sum / step;
    }
    return out;
  }
  // Non-integer ratio (unexpected on this pipeline): nearest-neighbour.
  for (let i = 0; i < outLength; i++) out[i] = mono[Math.floor(i * ratio)] ?? 0;
  return out;
}

/**
 * Model-based end-pointer. Same hangover / min-speech / max-utterance policy as
 * the energy segmenter — only the speech/not-speech decision differs, which is
 * the part energy gets wrong when music is playing under the speaker.
 */
export class SileroSegmenter implements VadSegmenter {
  private readonly opts: Required<Omit<SileroOptions, "modelPath" | "energyThreshold">> & {
    modelPath: string;
  };
  private session: OrtSession | null = null;
  private ort: OrtModule | null = null;
  private state: Float32Array = new Float32Array(2 * 1 * 128);
  /** 16 kHz float samples awaiting a full inference frame. */
  private pending: Float32Array = new Float32Array(0);
  /** Raw source-rate bytes of the utterance being collected. */
  private captured: Buffer[] = [];
  private speechMs = 0;
  private silenceMs = 0;
  private inSpeech = false;

  constructor(options: SileroOptions) {
    this.opts = {
      modelPath: options.modelPath,
      sampleRate: options.sampleRate,
      channels: options.channels ?? 1,
      speechThreshold: options.speechThreshold ?? 0.5,
      hangoverMs: options.hangoverMs ?? 700,
      minSpeechMs: options.minSpeechMs ?? 300,
      maxUtteranceMs: options.maxUtteranceMs ?? 15_000,
    };
  }

  /** Load the runtime + model. Returns false when unavailable (caller falls back). */
  async init(): Promise<boolean> {
    try {
      // Non-literal specifier: onnxruntime-node is intentionally not a
      // dependency, so a literal would fail `tsc` on every install without it.
      const specifier = "onnxruntime-node";
      this.ort = (await import(specifier)) as unknown as OrtModule;
      this.session = await this.ort.InferenceSession.create(this.opts.modelPath);
      return true;
    } catch {
      this.ort = null;
      this.session = null;
      return false;
    }
  }

  get ready(): boolean {
    return this.session !== null;
  }

  /**
   * Synchronous contract, asynchronous model: `push` buffers audio and returns
   * completed utterances, while inference advances in the background. Callers
   * already tolerate an utterance surfacing a frame or two late.
   */
  push(pcm: Buffer): Buffer | null {
    if (!this.session) return null;
    this.captured.push(pcm);
    const samples = toMono16k(pcm, this.opts.sampleRate, this.opts.channels);
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    this.pending = merged;
    void this.drainFrames();
    return this.takeCompleted();
  }

  private completed: Buffer | null = null;

  private takeCompleted(): Buffer | null {
    const out = this.completed;
    this.completed = null;
    return out;
  }

  private async drainFrames(): Promise<void> {
    while (this.pending.length >= SILERO_FRAME_SAMPLES && this.session && this.ort) {
      const frame = this.pending.subarray(0, SILERO_FRAME_SAMPLES);
      this.pending = this.pending.slice(SILERO_FRAME_SAMPLES);
      const isSpeech = await this.classify(frame);
      this.advance(isSpeech, (SILERO_FRAME_SAMPLES / SILERO_SAMPLE_RATE) * 1000);
    }
  }

  private async classify(frame: Float32Array): Promise<boolean> {
    if (!this.session || !this.ort) return false;
    try {
      const { Tensor } = this.ort;
      const feeds = {
        input: new Tensor("float32", Float32Array.from(frame), [1, SILERO_FRAME_SAMPLES]),
        sr: new Tensor("int64", BigInt64Array.from([BigInt(SILERO_SAMPLE_RATE)]), [1]),
        state: new Tensor("float32", this.state, SILERO_STATE_DIMS),
      };
      const out = await this.session.run(feeds);
      const stateOut = out.stateN ?? out.state;
      if (stateOut?.data) this.state = Float32Array.from(stateOut.data);
      const prob = out.output?.data?.[0] ?? 0;
      return prob >= this.opts.speechThreshold;
    } catch {
      return false;
    }
  }

  private advance(isSpeech: boolean, frameMs: number): void {
    if (isSpeech) {
      this.inSpeech = true;
      this.speechMs += frameMs;
      this.silenceMs = 0;
    } else if (this.inSpeech) {
      this.silenceMs += frameMs;
    }

    const tooLong = this.speechMs + this.silenceMs >= this.opts.maxUtteranceMs;
    const ended = this.inSpeech && this.silenceMs >= this.opts.hangoverMs;
    if (!ended && !tooLong) return;

    if (this.speechMs >= this.opts.minSpeechMs) {
      this.completed = Buffer.concat(this.captured);
    }
    this.reset();
  }

  private reset(): void {
    this.captured = [];
    this.speechMs = 0;
    this.silenceMs = 0;
    this.inSpeech = false;
  }

  flush(): Buffer | null {
    if (!this.inSpeech || this.speechMs < this.opts.minSpeechMs) {
      this.reset();
      return null;
    }
    const out = Buffer.concat(this.captured);
    this.reset();
    return out;
  }
}
