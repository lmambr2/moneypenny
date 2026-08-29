/**
 * Single loader for `@moneypenny/audio-native`.
 * Callers keep a JS fallback — never throw from here.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type VoiceDecodeResult = {
  ok: boolean;
  reason: string;
  pcm: Buffer;
  frames: number;
};

export type VoiceFrameProcessed = {
  peak: number;
  rawPeak: number;
  rms: number;
  speech: boolean;
  clipped: boolean;
  pcmForStt: Buffer;
};

export type NativeAudioMod = {
  NativeOpus: new (
    sampleRate: number,
    channels: number,
  ) => {
    encode(pcm: Buffer): Buffer;
    decode(opus: Buffer): Buffer;
    setBitrateBps?(bps: number): void;
    decodeVoice?(packet: Buffer): VoiceDecodeResult;
  };
  NativeVoiceFrame: new () => {
    inspect(pcm: Buffer): { peak: number; rms: number; speech: boolean; clipped: boolean };
    prepareStt(pcm: Buffer): Buffer;
    process(pcm: Buffer): VoiceFrameProcessed;
  };
  pcmRms(pcm: Buffer): number;
  pcmPeak(pcm: Buffer): number;
  pcmScale(pcm: Buffer, gain: number): Buffer;
  pcmMix(a: Buffer, gainA: number, b: Buffer, gainB: number): Buffer;
  pcmApplyPlaybackGain(
    pcm: Buffer,
    volumePct: number,
    duckActive: boolean,
    duckLevel: number,
    floorPct: number,
  ): Buffer;
  normalizePcmForStt(
    pcm: Buffer,
    targetPeak: number,
    maxGain: number,
    minBoostPeak: number,
  ): Buffer;
  isSpeechFrame(pcm: Buffer, energyThreshold: number): boolean;
  splitOpusPacket(packet: Buffer): Buffer[];
  isDtxSizedPacket(packet: Buffer): boolean;
  nativeAudioBackend(): string;
};

let cached: NativeAudioMod | null | undefined;

export function loadNativeAudio(): NativeAudioMod | null {
  if (cached !== undefined) return cached;
  try {
    cached = require("@moneypenny/audio-native") as NativeAudioMod;
    return cached;
  } catch {
    cached = null;
    return null;
  }
}

/** Test helper. */
export function setNativeAudioForTests(mod: NativeAudioMod | null): void {
  cached = mod;
}
