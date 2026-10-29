import { describe, expect, it, vi } from "vitest";
import { PCM_FRAME_BYTES } from "../audio/encoder.js";
import { DuplexPcmPump, downsample48kTo24kMono, talkerMono24kToStereo48k } from "./duplex-pump.js";

describe("duplex pcm pump", () => {
  it("turns 24 kHz mono into 48 kHz stereo and emits 20 ms frames only while allowed", () => {
    const samples = 960;
    const mono = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) mono.writeInt16LE(i === 0 ? 1000 : 0, i * 2);
    const stereo = talkerMono24kToStereo48k(mono);
    expect(stereo.length).toBe(samples * 8);
    expect(stereo.readInt16LE(0)).toBe(1000);
    expect(stereo.readInt16LE(2)).toBe(1000);
    expect(stereo.length / PCM_FRAME_BYTES).toBe(2);

    const encode = vi.fn((pcm: Buffer) => Buffer.from([pcm.length & 0xff]));
    const send = vi.fn();
    let allow = true;
    const pump = new DuplexPcmPump({ encode }, send, () => allow);
    expect(pump.pushTalkerPcm(mono)).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);

    allow = false;
    expect(pump.pushTalkerPcm(mono)).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("downsamples 48 kHz user audio to 24 kHz mono", () => {
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(10, 0);
    pcm.writeInt16LE(20, 2);
    pcm.writeInt16LE(30, 4);
    pcm.writeInt16LE(40, 6);
    const mono = downsample48kTo24kMono(pcm, 1);
    expect(mono.length).toBe(4);
    expect(mono.readInt16LE(0)).toBe(10);
    expect(mono.readInt16LE(2)).toBe(30);
  });
});
