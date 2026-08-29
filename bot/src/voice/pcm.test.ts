import { describe, expect, it } from "vitest";
import {
  isPcmClipped,
  normalizePcmForStt,
  peakAmplitude16,
  prepareVoicePcm,
  STT_TARGET_PEAK,
} from "./pcm.js";

describe("normalizePcmForStt", () => {
  it("boosts quiet PCM toward the target peak", () => {
    const pcm = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) pcm.writeInt16LE(200, i * 2);
    const out = normalizePcmForStt(pcm);
    expect(peakAmplitude16(out)).toBeGreaterThan(peakAmplitude16(pcm));
  });

  it("does not boost Opus DTX comfort noise", () => {
    const pcm = Buffer.alloc(200);
    pcm.writeInt16LE(3, 0);
    const out = normalizePcmForStt(pcm);
    expect(peakAmplitude16(out)).toBe(3);
  });

  it("boosts quiet but real speech", () => {
    const pcm = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) pcm.writeInt16LE(120, i * 2);
    const out = normalizePcmForStt(pcm);
    expect(peakAmplitude16(out)).toBeGreaterThan(120);
  });

  it("attenuates already-loud PCM toward the target peak", () => {
    const pcm = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) pcm.writeInt16LE(20_000, i * 2);
    const out = normalizePcmForStt(pcm);
    expect(peakAmplitude16(out)).toBe(STT_TARGET_PEAK);
  });

  it("attenuates clipped int16 PCM below target (extra headroom for distorted input)", () => {
    const pcm = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) pcm.writeInt16LE(32_767, i * 2);
    const out = normalizePcmForStt(pcm);
    expect(isPcmClipped(out)).toBe(false);
    expect(peakAmplitude16(out)).toBe(Math.round(STT_TARGET_PEAK * 0.65));
  });

  it("prepareVoicePcm reports raw peak, speech, and STT buffer", () => {
    const pcm = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) pcm.writeInt16LE(200, i * 2);
    const prep = prepareVoicePcm(pcm);
    expect(prep.rawPeak).toBe(200);
    expect(prep.speech).toBe(true);
    expect(prep.clipped).toBe(false);
    expect(peakAmplitude16(prep.pcmForStt)).toBeGreaterThan(200);
  });
});
