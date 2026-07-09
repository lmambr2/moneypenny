import { describe, expect, it } from "vitest";
import { normalizeLoudness } from "./loudness.js";

/** Minimal 16-bit PCM mono WAV with a quiet sine (peak ~6% of full scale). */
function quietWav(seconds = 1, sr = 16000): Buffer {
  const n = seconds * sr;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sr) * 2000), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function peak16(wav: Buffer): number {
  let peak = 0;
  for (let i = 44; i + 1 < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
  return peak;
}

describe("normalizeLoudness", () => {
  it("boosts a quiet clip toward music loudness", async () => {
    const input = quietWav();
    const out = await normalizeLoudness(input, "wav");
    expect(out.length).toBeGreaterThan(44);
    expect(peak16(out)).toBeGreaterThan(peak16(input) * 2); // audibly louder, not a passthrough
  });

  it("fails open on garbage input (returns the original buffer)", async () => {
    const garbage = Buffer.from("this is not audio");
    const out = await normalizeLoudness(garbage, "wav");
    expect(out).toBe(garbage);
  });
});
