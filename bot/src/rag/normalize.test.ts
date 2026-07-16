import { describe, expect, it } from "vitest";
import { l2Normalize, l2NormalizeBatch } from "./normalize.js";

describe("l2Normalize", () => {
  it("unit-length for 3-4-5", () => {
    const v = l2Normalize([3, 4]);
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 6);
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
  });

  it("leaves zero vector alone", () => {
    expect(l2Normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("batch maps each row", () => {
    const out = l2NormalizeBatch([
      [3, 4],
      [0, 2],
    ]);
    expect(Math.hypot(out[0][0], out[0][1])).toBeCloseTo(1, 6);
    expect(out[1][1]).toBeCloseTo(1, 6);
  });
});
