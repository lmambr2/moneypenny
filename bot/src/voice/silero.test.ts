import { describe, expect, it } from "vitest";
import { SileroSegmenter, toMono16k } from "./silero.js";
import { createVadSegmenterAsync, SilenceSegmenter } from "./vad.js";

/** Interleaved s16 buffer from per-channel sample values. */
function pcm(frames: number[][], channels: number): Buffer {
  const buf = Buffer.alloc(frames.length * channels * 2);
  frames.forEach((f, i) => {
    for (let c = 0; c < channels; c++) buf.writeInt16LE(f[c] ?? 0, (i * channels + c) * 2);
  });
  return buf;
}

describe("toMono16k", () => {
  it("downmixes stereo to mono and normalizes to -1..1", () => {
    const buf = pcm(
      [
        [32767, 32767],
        [-32768, -32768],
      ],
      2,
    );
    const out = toMono16k(buf, 16_000, 2);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(1, 2);
    expect(out[1]).toBeCloseTo(-1, 2);
  });

  it("averages the two channels rather than taking one", () => {
    const buf = pcm([[32767, -32768]], 2);
    const out = toMono16k(buf, 16_000, 2);
    expect(Math.abs(out[0]!)).toBeLessThan(0.01);
  });

  it("decimates 48 kHz to 16 kHz at a 3:1 ratio", () => {
    const frames = Array.from({ length: 48 }, () => [1000]);
    const out = toMono16k(pcm(frames, 1), 48_000, 1);
    expect(out.length).toBe(16);
  });

  it("preserves a constant signal through decimation", () => {
    const frames = Array.from({ length: 30 }, () => [16384]);
    const out = toMono16k(pcm(frames, 1), 48_000, 1);
    for (const v of out) expect(v).toBeCloseTo(0.5, 2);
  });

  it("returns an empty array for an empty buffer", () => {
    expect(toMono16k(Buffer.alloc(0), 48_000, 2).length).toBe(0);
  });
});

describe("SileroSegmenter without a model", () => {
  it("reports not ready and stays inert rather than throwing", async () => {
    const seg = new SileroSegmenter({
      modelPath: "/nonexistent/silero_vad.onnx",
      sampleRate: 48_000,
      channels: 1,
    });
    expect(await seg.init()).toBe(false);
    expect(seg.ready).toBe(false);
    expect(seg.push(pcm([[1000]], 1))).toBeNull();
    expect(seg.flush()).toBeNull();
  });
});

describe("createVadSegmenterAsync", () => {
  it("defaults to silero and falls back to energy without a model", async () => {
    const seg = await createVadSegmenterAsync({ sampleRate: 48_000 });
    expect(seg).toBeInstanceOf(SilenceSegmenter);
  });

  it("falls back to energy when silero is selected with no model path", async () => {
    const notices: string[] = [];
    const seg = await createVadSegmenterAsync({
      sampleRate: 48_000,
      backend: "silero",
      onFallback: (m) => notices.push(m),
    });
    expect(seg).toBeInstanceOf(SilenceSegmenter);
    expect(notices.join(" ")).toContain("no modelPath");
  });

  // Losing end-pointing quality is recoverable; losing voice entirely is not.
  it("falls back to energy when the model file is missing", async () => {
    const notices: string[] = [];
    const seg = await createVadSegmenterAsync({
      sampleRate: 48_000,
      backend: "silero",
      modelPath: "/nonexistent/silero_vad.onnx",
      onFallback: (m) => notices.push(m),
    });
    expect(seg).toBeInstanceOf(SilenceSegmenter);
    expect(notices.length).toBeGreaterThan(0);
  });
});
