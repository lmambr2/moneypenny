import { describe, it, expect } from "vitest";
import { createOpusEncoder } from "./encoder.js";
import { decodeVoiceOpusPacket } from "./opus-voice.js";

describe("decodeVoiceOpusPacket", () => {
  it("classifies undecodable tiny payloads as DTX", () => {
    const enc = createOpusEncoder(1);
    expect(decodeVoiceOpusPacket(enc, Buffer.from([0xff, 0xff, 0xff]))).toEqual({ ok: false, reason: "dtx" });
  });

  it("decodes tiny but valid silence frames", () => {
    const enc = createOpusEncoder(1);
    const opus = enc.encode(Buffer.alloc(960 * 2, 0));
    expect(opus.length).toBeLessThanOrEqual(12);
    const out = decodeVoiceOpusPacket(enc, opus);
    expect(out.ok).toBe(true);
  });

  it("decodes a valid mono frame", () => {
    const enc = createOpusEncoder(1);
    const pcm = Buffer.alloc(960 * 2, 0);
    const opus = enc.encode(pcm);
    const out = decodeVoiceOpusPacket(enc, opus);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.pcm.length).toBe(960 * 2);
      expect(out.frames).toBe(1);
    }
  });

  it("decodes a two-frame CBR packet (whole or per-frame fallback)", () => {
    const enc = createOpusEncoder(1);
    const pcm = Buffer.alloc(960 * 2, 0);
    const a = enc.encode(pcm);
    const b = enc.encode(pcm);
    const toc = a[0]! & 0xfc;
    const packet = Buffer.concat([Buffer.from([toc | 0x01]), a.subarray(1), b.subarray(1)]);
    const out = decodeVoiceOpusPacket(enc, packet);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.frames).toBeGreaterThanOrEqual(1);
      expect(out.pcm.length).toBe(960 * 2 * 2);
    }
  });
});