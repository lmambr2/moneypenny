import { describe, expect, it } from "vitest";
import { orderKeysByRatingWeight } from "./rating-weight.js";

describe("orderKeysByRatingWeight", () => {
  it("when disabled, is a permutation (shuffle)", () => {
    const keys = ["a", "b", "c", "d"];
    let i = 0;
    const seq = [0.9, 0.1, 0.5, 0.2, 0.8, 0.3];
    const rng = () => seq[i++ % seq.length]!;
    const out = orderKeysByRatingWeight(keys, () => 3, { enabled: false }, rng);
    expect(out.sort()).toEqual([...keys].sort());
    expect(out).toHaveLength(4);
  });

  it("when enabled, prefers higher scores on average with fixed rng bias", () => {
    const keys = ["low", "high"];
    const scoreOf = (k: string) => (k === "high" ? 5 : 1);
    // Always pick first weight bucket greedily: high should often come first
    // Use rng that always returns 0 → always pick first remaining by weight order
    // First draw: weights ~ high bigger → total, r=0 → first item in iteration with cumulative
    let firstHigh = 0;
    for (let trial = 0; trial < 50; trial++) {
      // deterministic but varied
      let n = trial * 17 + 3;
      const rng = () => {
        n = (n * 1103515245 + 12345) & 0x7fffffff;
        return (n % 1000) / 1000;
      };
      const out = orderKeysByRatingWeight(
        keys,
        scoreOf,
        { enabled: true, exponent: 2, maxRatio: 10 },
        rng,
      );
      if (out[0] === "high") firstHigh++;
    }
    expect(firstHigh).toBeGreaterThan(30); // strong preference
  });

  it("always returns all keys", () => {
    const keys = ["a", "b", "c"];
    const out = orderKeysByRatingWeight(keys, (k) => (k === "c" ? 5 : 2), {
      enabled: true,
    });
    expect(out.sort()).toEqual(["a", "b", "c"]);
  });
});
