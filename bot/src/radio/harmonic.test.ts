import { describe, expect, it } from "vitest";
import { camelotCompatible, orderKeysHarmonically, toCamelot } from "./harmonic.js";

describe("toCamelot", () => {
  it("maps common keys", () => {
    expect(toCamelot("C", "major")).toBe("8B");
    expect(toCamelot("A", "minor")).toBe("8A");
    expect(toCamelot("G", "major")).toBe("9B");
  });
});

describe("camelotCompatible", () => {
  it("same and neighbors", () => {
    expect(camelotCompatible("8B", "8B")).toBe(true);
    expect(camelotCompatible("8B", "8A")).toBe(true);
    expect(camelotCompatible("8B", "9B")).toBe(true);
    expect(camelotCompatible("8B", "1A")).toBe(false);
  });
});

describe("orderKeysHarmonically", () => {
  const meta: Record<string, { musicalKey: string; keyScale: string }> = {
    c: { musicalKey: "C", keyScale: "major" }, // 8B
    g: { musicalKey: "G", keyScale: "major" }, // 9B adjacent
    fsharp: { musicalKey: "F#", keyScale: "major" }, // 2B far
    none: { musicalKey: "", keyScale: "" },
  };

  it("when disabled returns original order", () => {
    expect(orderKeysHarmonically(["fsharp", "c", "g"], (k) => meta[k], false)).toEqual([
      "fsharp",
      "c",
      "g",
    ]);
  });

  it("when enabled prefers harmonic neighbors after the start key", () => {
    // Start fsharp (2B); next should prefer far? actually greedy from fsharp
    // Better test: start with C, then F# and G — G is adjacent to C, F# is not
    const out = orderKeysHarmonically(["c", "fsharp", "g"], (k) => meta[k], true);
    expect(out[0]).toBe("c");
    expect(out[1]).toBe("g"); // 9B adjacent to 8B
    expect(out[2]).toBe("fsharp");
  });

  it("parks keyless tracks at the end", () => {
    const out = orderKeysHarmonically(["none", "c", "g"], (k) => meta[k], true);
    expect(out[out.length - 1]).toBe("none");
  });
});
