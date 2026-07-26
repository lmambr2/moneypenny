import { describe, expect, it } from "vitest";
import { createOpusEncoder, opusBackendAvailable, PCM_FRAME_BYTES } from "./encoder.js";

/** 20ms @ 48kHz stereo s16 = 960 frames * 2ch * 2 bytes. */
const FRAME = PCM_FRAME_BYTES;

function tone(bytes = FRAME, amplitude = 8000): Buffer {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i + 1 < bytes; i += 2) {
    b.writeInt16LE(Math.round(Math.sin((i / 2) * 0.05) * amplitude), i);
  }
  return b;
}

describe("opusBackendAvailable", () => {
  // @discordjs/opus was removed: it vendors a libopus whose ARM NEON path uses
  // implicit function declarations, which GCC 14 rejects, so it cannot build on
  // a modern arm64 toolchain. The Rust addon is the only codec now.
  it("reports native or unavailable — never a fallback backend", () => {
    const info = opusBackendAvailable();
    expect(["native", "unavailable"]).toContain(info.active);
    expect(info.active === "native").toBe(info.native);
  });

  it("is stable across calls (load is memoized)", () => {
    expect(opusBackendAvailable()).toEqual(opusBackendAvailable());
  });
});

describe("createOpusEncoder", () => {
  const available = opusBackendAvailable().native;

  it("either returns a native encoder or throws — never silently degrades", () => {
    if (available) {
      expect(createOpusEncoder().backend).toBe("native");
    } else {
      // The failure must be loud and name the fix; a container that starts and
      // then cannot emit audio is the outcome this guards against.
      expect(() => createOpusEncoder()).toThrow(/audio-native/);
    }
  });

  it.runIf(available)("round-trips a frame of silence", () => {
    const enc = createOpusEncoder();
    const opus = enc.encode(Buffer.alloc(FRAME, 0));
    expect(opus).toBeInstanceOf(Buffer);
    expect(opus.length).toBeGreaterThan(0);
    // Compressed output must actually be smaller than raw PCM.
    expect(opus.length).toBeLessThan(FRAME);

    const pcm = enc.decode(opus);
    expect(pcm).toBeInstanceOf(Buffer);
    expect(pcm.length).toBeGreaterThanOrEqual(FRAME);
  });

  it.runIf(available)("preserves signal energy through a round trip", () => {
    const enc = createOpusEncoder();
    const input = tone();
    const pcm = enc.decode(enc.encode(input));

    const rms = (b: Buffer, n: number) => {
      let sum = 0;
      for (let i = 0; i + 1 < n; i += 2) {
        const s = b.readInt16LE(i);
        sum += s * s;
      }
      return Math.sqrt(sum / (n / 2));
    };

    // Opus is lossy, so this is a sanity band, not equality: a decoded tone must
    // be clearly non-silent and in the same order of magnitude as the input.
    const inRms = rms(input, FRAME);
    const outRms = rms(pcm, FRAME);
    expect(outRms).toBeGreaterThan(inRms * 0.25);
    expect(outRms).toBeLessThan(inRms * 4);
  });

  it.runIf(available)("supports mono for the voice capture path", () => {
    // VoiceSession decodes inbound speaker audio at 1 channel.
    const enc = createOpusEncoder(1);
    expect(enc.backend).toBe("native");
    const opus = enc.encode(Buffer.alloc(FRAME / 2, 0));
    expect(opus.length).toBeGreaterThan(0);
  });

  it.runIf(available)("returns independent encoder instances", () => {
    const a = createOpusEncoder();
    const b = createOpusEncoder();
    expect(a).not.toBe(b);
    expect(a.encode(Buffer.alloc(FRAME, 0)).length).toBeGreaterThan(0);
    expect(b.encode(Buffer.alloc(FRAME, 0)).length).toBeGreaterThan(0);
  });
});
