import { createRequire } from "node:module";
import opusModule from "@discordjs/opus";

const { OpusEncoder } = opusModule;
const require = createRequire(import.meta.url);

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_DURATION_MS = 20;
export const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960 samples
export const PCM_FRAME_BYTES = FRAME_SIZE * CHANNELS * 2; // 3840 bytes (16-bit stereo)

export interface Encoder {
  encode(pcm: Buffer): Buffer;
  decode(opus: Buffer): Buffer;
  /** Which backend produced this encoder. */
  backend?: "native" | "discordjs";
}

type NativeOpusInstance = {
  encode(pcm: Buffer): Buffer;
  decode(opus: Buffer): Buffer;
};

type NativeMod = {
  NativeOpus: new (sampleRate: number, channels: number) => NativeOpusInstance;
};

let nativeTried = false;
let NativeOpusCtor: NativeMod["NativeOpus"] | null = null;

function tryLoadNative(): NativeMod["NativeOpus"] | null {
  if (nativeTried) return NativeOpusCtor;
  nativeTried = true;
  try {
    const mod = require("@moneypenny/audio-native") as NativeMod;
    NativeOpusCtor = mod.NativeOpus;
    return NativeOpusCtor;
  } catch {
    NativeOpusCtor = null;
    return null;
  }
}

/**
 * Prefer Rust N-API Opus via @moneypenny/audio-native (PR-B4).
 * Falls back to @discordjs/opus when the native addon is missing or fails.
 */
export function createOpusEncoder(channels: number = CHANNELS): Encoder {
  const Ctor = tryLoadNative();
  if (Ctor) {
    try {
      const native = new Ctor(SAMPLE_RATE, channels);
      return {
        backend: "native",
        encode(pcm: Buffer): Buffer {
          return native.encode(pcm);
        },
        decode(opusData: Buffer): Buffer {
          return native.decode(opusData);
        },
      };
    } catch {
      // fall through
    }
  }

  const opus = new OpusEncoder(SAMPLE_RATE, channels);
  return {
    backend: "discordjs",
    encode(pcm: Buffer): Buffer {
      return opus.encode(pcm);
    },
    decode(opusData: Buffer): Buffer {
      return opus.decode(opusData);
    },
  };
}

/** Diagnostics for tests / health. */
export function opusBackendAvailable(): { native: boolean; active: "native" | "discordjs" } {
  const native = tryLoadNative() !== null;
  return { native, active: native ? "native" : "discordjs" };
}
