import { describe, expect, it } from "vitest";
import { createOpusEncoder, opusBackendAvailable } from "./encoder.js";

describe("OpusEncoder", () => {
  it("reports backend availability", () => {
    const info = opusBackendAvailable();
    expect(["native", "discordjs"]).toContain(info.active);
  });

  it("encodes PCM buffer to Opus frame", () => {
    const encoder = createOpusEncoder();
    expect(encoder.backend === "native" || encoder.backend === "discordjs").toBe(true);
    // 20ms of silence at 48kHz stereo = 960 frames * 2 channels * 2 bytes = 3840 bytes
    const silence = Buffer.alloc(3840, 0);
    const opus = encoder.encode(silence);
    expect(opus).toBeInstanceOf(Buffer);
    expect(opus.length).toBeGreaterThan(0);
    expect(opus.length).toBeLessThan(3840);
  });

  it("decodes Opus frame back to PCM", () => {
    const encoder = createOpusEncoder();
    const silence = Buffer.alloc(3840, 0);
    const opus = encoder.encode(silence);
    const pcm = encoder.decode(opus);
    expect(pcm).toBeInstanceOf(Buffer);
    // Native and discordjs may pad frames slightly differently; require full frame.
    expect(pcm.length).toBeGreaterThanOrEqual(3840);
  });
});
