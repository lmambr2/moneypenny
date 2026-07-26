import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_DURATION_MS = 20;
export const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960 samples
export const PCM_FRAME_BYTES = FRAME_SIZE * CHANNELS * 2; // 3840 bytes (16-bit stereo)

export interface Encoder {
  encode(pcm: Buffer): Buffer;
  decode(opus: Buffer): Buffer;
  /** Which backend produced this encoder. Only the Rust N-API addon remains. */
  backend?: "native";
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
 * Opus via the Rust N-API addon @moneypenny/audio-native (PR-B4).
 *
 * There is no fallback. @discordjs/opus was dropped because it vendors a
 * libopus whose ARM NEON path relies on implicit function declarations, which
 * GCC 14 (Debian 13) rejects outright — it cannot build on a modern arm64
 * toolchain. Removing it also takes the node-pre-gyp -> tar advisory chain with
 * it, which was the original reason to want it gone.
 *
 * Consequences, deliberately chosen: the native addon is now REQUIRED, so
 * `npm run build` must not swallow a failed Rust build (the `|| true` is gone)
 * and the image build asserts the addon loads. Failing loudly here beats a
 * container that starts fine and then cannot emit audio.
 */
export function createOpusEncoder(channels: number = CHANNELS): Encoder {
  const Ctor = tryLoadNative();
  if (!Ctor) {
    throw new Error(
      "@moneypenny/audio-native failed to load — no Opus codec available. " +
        "Build it with `npm run build:native` (or `build:native:arm64`); " +
        "there is no @discordjs/opus fallback any more.",
    );
  }
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
}

/** Diagnostics for tests / health. */
export function opusBackendAvailable(): { native: boolean; active: "native" | "unavailable" } {
  const native = tryLoadNative() !== null;
  return { native, active: native ? "native" : "unavailable" };
}

let loggedBackendOnce = false;

/**
 * Create encoder and optionally log the active backend once (audit C3 hygiene).
 * Prefer calling from bot startup so ops know whether arm64 native loaded.
 */
export function createOpusEncoderLogged(
  channels: number = CHANNELS,
  log?: (msg: string, meta?: Record<string, unknown>) => void,
): Encoder {
  const enc = createOpusEncoder(channels);
  if (!loggedBackendOnce && log) {
    loggedBackendOnce = true;
    const info = opusBackendAvailable();
    log("Opus encoder backend", {
      backend: enc.backend ?? info.active,
      nativeAvailable: info.native,
    });
  }
  return enc;
}
