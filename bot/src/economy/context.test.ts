import { describe, expect, it } from "vitest";
import { economyContextForQuestion, isEconomyQuestion } from "./context.js";

describe("economyContextForQuestion", () => {
  it("ignores non-economy questions", () => {
    expect(isEconomyQuestion("play something chill")).toBe(false);
    expect(economyContextForQuestion("play something chill")).toEqual([]);
  });

  it("injects catalog + mine order for ore questions", () => {
    const chunks = economyContextForQuestion("how do I mine quantanium safely?");
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.source).toBe("economy/catalog");
    expect(chunks.some((c) => c.source.startsWith("economy/mine:"))).toBe(true);
  });
});
