import { describe, expect, it, vi } from "vitest";
import { createVadSegmenter, rms16, SilenceSegmenter } from "./vad.js";

const SR = 16_000;
// 20ms mono frame at 16kHz = 320 samples = 640 bytes.
function frame(amp: number, ms = 20): Buffer {
  const samples = (SR * ms) / 1000;
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(amp, i * 2);
  return buf;
}
const speech = () => frame(8000);
const silence = () => frame(0);

describe("rms16", () => {
  it("is zero for silence and high for a loud tone", () => {
    expect(rms16(silence())).toBe(0);
    expect(rms16(speech())).toBeCloseTo(8000, 0);
  });
  it("handles empty buffers", () => {
    expect(rms16(Buffer.alloc(0))).toBe(0);
  });
});

describe("SilenceSegmenter", () => {
  const opts = {
    sampleRate: SR,
    channels: 1,
    energyThreshold: 500,
    hangoverMs: 40,
    minSpeechMs: 40,
    maxUtteranceMs: 200,
  };

  it("drops pre-speech silence and emits after the hangover", () => {
    const seg = new SilenceSegmenter(opts);
    expect(seg.push(silence())).toBeNull(); // pre-speech silence dropped
    expect(seg.push(speech())).toBeNull();
    expect(seg.push(speech())).toBeNull(); // 40ms speech
    expect(seg.push(silence())).toBeNull(); // 20ms silence (< hangover)
    const out = seg.push(silence()); // 40ms silence ≥ hangover → emit
    expect(out).not.toBeNull();
    // 2 speech + 2 trailing silence frames retained; pre-speech silence excluded.
    expect(out!.length).toBe(4 * speech().length);
  });

  it("discards utterances shorter than minSpeechMs (blips)", () => {
    const seg = new SilenceSegmenter(opts);
    expect(seg.push(speech())).toBeNull(); // only 20ms speech (< 40ms min)
    expect(seg.push(silence())).toBeNull();
    expect(seg.push(silence())).toBeNull(); // hangover reached, but too short → discard
    // A subsequent real utterance still works (state was reset).
    seg.push(speech());
    seg.push(speech());
    seg.push(silence());
    expect(seg.push(silence())).not.toBeNull();
  });

  it("force-flushes an over-long utterance", () => {
    const seg = new SilenceSegmenter({ ...opts, maxUtteranceMs: 60 });
    expect(seg.push(speech())).toBeNull(); // 20ms
    expect(seg.push(speech())).toBeNull(); // 40ms
    const out = seg.push(speech()); // 60ms ≥ max → emit without waiting for silence
    expect(out).not.toBeNull();
    expect(out!.length).toBe(3 * speech().length);
  });

  it("flush() emits buffered speech and resets", () => {
    const seg = new SilenceSegmenter(opts);
    seg.push(speech());
    seg.push(speech());
    const out = seg.flush();
    expect(out).not.toBeNull();
    expect(seg.flush()).toBeNull(); // nothing left after reset
  });

  it("flush() with no/too-little speech returns null", () => {
    const seg = new SilenceSegmenter(opts);
    seg.push(silence());
    expect(seg.flush()).toBeNull();
  });
});

describe("createVadSegmenter", () => {
  const factoryOpts = {
    sampleRate: SR,
    channels: 1,
    energyThreshold: 500,
    hangoverMs: 40,
    minSpeechMs: 40,
    maxUtteranceMs: 200,
  };

  it("returns energy SilenceSegmenter by default", () => {
    const seg = createVadSegmenter(factoryOpts);
    expect(seg).toBeInstanceOf(SilenceSegmenter);
  });

  it("silero backend falls back to energy with notice", () => {
    const onFallback = vi.fn();
    const seg = createVadSegmenter({ ...factoryOpts, backend: "silero", onFallback });
    expect(seg).toBeInstanceOf(SilenceSegmenter);
    expect(onFallback).toHaveBeenCalledOnce();
  });
});

