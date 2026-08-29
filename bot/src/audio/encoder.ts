import { loadNativeAudio, type VoiceDecodeResult } from "./native.js";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_DURATION_MS = 20;
export const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960 samples
export const PCM_FRAME_BYTES = FRAME_SIZE * CHANNELS * 2; // 3840 bytes (16-bit stereo)

export interface Encoder {
  encode(pcm: Buffer): Buffer;
  decode(opus: Buffer): Buffer;
  /**
   * Target Opus bitrate in bits/second. `bps <= 0` = Auto (libopus default).
   * Optional — older native builds without setBitrateBps no-op safely.
   */
  setBitrate?(bps: number): void;
  /**
   * Native inbound voice-packet decode (whole then per-frame split).
   * Optional — JS `decodeVoiceOpusPacket` is the fallback.
   */
  decodeVoice?(packet: Buffer): VoiceDecodeResult;
  /** Which backend produced this encoder. Only the Rust N-API addon remains. */
  backend?: "native";
}

/** Music stream bitrate bounds (kbps). 0 = Auto. */
export const MUSIC_OPUS_BITRATE_KBPS_MIN = 24;
export const MUSIC_OPUS_BITRATE_KBPS_MAX = 160;
/** Dashboard default — solid stereo music without maxing Starlink uplink. */
export const MUSIC_OPUS_BITRATE_KBPS_DEFAULT = 64;

/**
 * Clamp dashboard kbps to a safe Opus range.
 * 0 stays 0 (Auto). Non-finite → default.
 */
export function clampMusicOpusBitrateKbps(kbps: unknown): number {
  if (kbps === 0 || kbps === "0") return 0;
  const n = typeof kbps === "number" ? kbps : Number(kbps);
  if (!Number.isFinite(n)) return MUSIC_OPUS_BITRATE_KBPS_DEFAULT;
  if (n <= 0) return 0;
  return Math.max(
    MUSIC_OPUS_BITRATE_KBPS_MIN,
    Math.min(MUSIC_OPUS_BITRATE_KBPS_MAX, Math.round(n)),
  );
}

function nativeCtor() {
  return loadNativeAudio()?.NativeOpus ?? null;
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
  const Ctor = nativeCtor();
  if (!Ctor) {
    throw new Error(
      "@moneypenny/audio-native failed to load — no Opus codec available. " +
        "Build it with `npm run build:native` (or `build:native:arm64`); " +
        "there is no @discordjs/opus fallback any more.",
    );
  }
  const native = new Ctor(SAMPLE_RATE, channels);
  const encoder: Encoder = {
    backend: "native",
    setBitrate(bps: number): void {
      if (typeof native.setBitrateBps !== "function") return;
      const n = Number(bps);
      if (!Number.isFinite(n)) return;
      native.setBitrateBps(n <= 0 ? 0 : Math.round(n));
    },
    encode(pcm: Buffer): Buffer {
      return native.encode(pcm);
    },
    decode(opusData: Buffer): Buffer {
      return native.decode(opusData);
    },
  };
  if (typeof native.decodeVoice === "function") {
    encoder.decodeVoice = (packet) => native.decodeVoice!(packet);
  }
  return encoder;
}

/** Diagnostics for tests / health. */
export function opusBackendAvailable(): { native: boolean; active: "native" | "unavailable" } {
  const native = nativeCtor() !== null;
  return { native, active: native ? "native" : "unavailable" };
}
