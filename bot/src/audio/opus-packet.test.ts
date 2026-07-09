import { describe, expect, it } from "vitest";
import { createOpusEncoder } from "./encoder.js";
import { isDtxSizedPacket, splitOpusPacket } from "./opus-packet.js";

describe("opus-packet", () => {
  it("flags tiny DTX-sized payloads for post-decode classification", () => {
    expect(isDtxSizedPacket(Buffer.alloc(8))).toBe(true);
    expect(isDtxSizedPacket(Buffer.alloc(13))).toBe(false);
  });

  it("returns a single frame for a mono 20ms packet", () => {
    const enc = createOpusEncoder(1);
    const pcm = Buffer.alloc(960 * 2, 0);
    const opus = enc.encode(pcm);
    const frames = splitOpusPacket(opus);
    expect(frames).toHaveLength(1);
    expect(frames![0]).toEqual(opus);
  });

  it("splits a two-frame CBR packet", () => {
    const enc = createOpusEncoder(1);
    const pcm = Buffer.alloc(960 * 2, 0);
    const a = enc.encode(pcm);
    const b = enc.encode(pcm);
    const toc = a[0]! & 0xfc;
    const packet = Buffer.concat([Buffer.from([toc | 0x01]), a.subarray(1), b.subarray(1)]);
    const frames = splitOpusPacket(packet);
    expect(frames).toHaveLength(2);
    expect(frames![0]!.subarray(1)).toEqual(a.subarray(1));
    expect(frames![1]!.subarray(1)).toEqual(b.subarray(1));
  });
});
