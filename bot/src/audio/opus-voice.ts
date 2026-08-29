import type { Encoder } from "./encoder.js";
import { OPUS_DTX_MAX_BYTES, splitOpusPacket } from "./opus-packet.js";

export type VoiceOpusDecodeResult =
  | { ok: true; pcm: Buffer; frames: number }
  | { ok: false; reason: "empty" | "dtx" | "corrupt" };

function tryDecode(encoder: Encoder, packet: Buffer): Buffer | null {
  try {
    return encoder.decode(packet);
  } catch {
    return null;
  }
}

/** Undecodable tiny payloads are treated as TeamSpeak DTX comfort noise. */
function isDtxSizedFailure(packet: Buffer): boolean {
  return packet.length <= OPUS_DTX_MAX_BYTES;
}

/**
 * Decode a TeamSpeak Opus voice payload (codec 4, mono 48 kHz).
 *
 * Valid speech frames can be very small (e.g. ~3 bytes of encoded silence), so we
 * never skip based on size alone — only classify as DTX after decode fails.
 *
 * Multi-frame packets are split and decoded per-frame when the bundled decode fails.
 */
export function decodeVoiceOpusPacket(encoder: Encoder, packet: Buffer): VoiceOpusDecodeResult {
  if (packet.length === 0) return { ok: false, reason: "empty" };

  if (typeof encoder.decodeVoice === "function") {
    const native = encoder.decodeVoice(packet);
    if (native.ok) {
      return { ok: true, pcm: native.pcm, frames: native.frames };
    }
    if (native.reason === "empty" || native.reason === "dtx" || native.reason === "corrupt") {
      return { ok: false, reason: native.reason };
    }
  }

  const whole = tryDecode(encoder, packet);
  if (whole) return { ok: true, pcm: whole, frames: 1 };

  const frames = splitOpusPacket(packet);
  if (frames && frames.length > 1) {
    const parts: Buffer[] = [];
    for (const frame of frames) {
      const pcm = tryDecode(encoder, frame);
      if (pcm) parts.push(pcm);
    }
    if (parts.length > 0) {
      return { ok: true, pcm: Buffer.concat(parts), frames: parts.length };
    }
  }

  if (isDtxSizedFailure(packet)) return { ok: false, reason: "dtx" };
  return { ok: false, reason: "corrupt" };
}
