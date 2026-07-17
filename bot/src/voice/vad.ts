/**
 * Energy-based voice end-pointing (DESIGN §10's "circular-buffer + VAD
 * end-pointing" pattern).
 *
 * This is a simple, dependency-free RMS-energy segmenter: it accumulates audio
 * while speech is present and emits a completed utterance once trailing silence
 * exceeds the hangover window. It is intentionally model-free so it is fully
 * unit-testable; for production it can be swapped for Silero VAD (bundled with
 * sherpa-onnx) behind the same push()/flush() shape.
 *
 * Operates on 16-bit little-endian PCM. Multi-channel input is treated as
 * interleaved; energy is computed across all samples.
 *
 * PR-B4: RMS prefers Rust N-API `@moneypenny/audio-native` when built.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

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

let nativeRms: ((pcm: Buffer) => number) | null | undefined;

function loadNativeRms(): ((pcm: Buffer) => number) | null {
  if (nativeRms !== undefined) return nativeRms;
  try {
    const mod = require("@moneypenny/audio-native") as { pcmRms: (pcm: Buffer) => number };
    nativeRms = mod.pcmRms;
    return nativeRms;
  } catch {
    nativeRms = null;
    return null;
  }
}

/** RMS of s16le PCM. Prefers Rust N-API (PR-B4) when available. */
export function rms16(pcm: Buffer): number {
  const native = loadNativeRms();
  if (native) {
    try {
      return native(pcm);
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

export class SilenceSegmenter {
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
