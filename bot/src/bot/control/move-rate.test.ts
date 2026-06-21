import { describe, it, expect } from "vitest";
import { MoveClientRateLimiter } from "./move-rate.js";

describe("MoveClientRateLimiter", () => {
  it("allows up to maxPerWindow then blocks", () => {
    const lim = new MoveClientRateLimiter(3, 60_000);
    expect(lim.tryTake(0)).toBe(true);
    expect(lim.tryTake(1)).toBe(true);
    expect(lim.tryTake(2)).toBe(true);
    expect(lim.tryTake(3)).toBe(false);
    expect(lim.tryTake(59_999)).toBe(false);
    expect(lim.tryTake(60_001)).toBe(true);
  });
});