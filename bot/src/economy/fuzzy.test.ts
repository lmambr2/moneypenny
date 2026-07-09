import { describe, expect, it } from "vitest";
import {
  foldConfusable,
  fuzzyBestMatch,
  fuzzyCompact,
  fuzzyNormalize,
  fuzzyRank,
  fuzzyScore,
  levenshtein,
  similarity,
} from "./fuzzy.js";

describe("fuzzy normalize / confusable", () => {
  it("folds quantanium → quantainium", () => {
    expect(foldConfusable("Quantanium Ore")).toMatch(/quantainium/i);
    expect(fuzzyCompact("Quantanium")).toBe(fuzzyCompact("Quantainium"));
  });

  it("normalizes punctuation", () => {
    expect(fuzzyNormalize("Freelancer_MAX")).toBe("freelancer max");
    expect(fuzzyCompact("P4-AR")).toBe("p4ar");
  });
});

describe("levenshtein / similarity", () => {
  it("identical is distance 0 / sim 1", () => {
    expect(levenshtein("bexalite", "bexalite")).toBe(0);
    expect(similarity("Bexalite", "bexalite")).toBe(1);
  });

  it("near-miss scores high", () => {
    expect(similarity("bexalit", "bexalite")).toBeGreaterThan(0.8);
    expect(similarity("agricum", "agricium")).toBeGreaterThan(0.75);
  });
});

describe("fuzzyScore / rank / best", () => {
  const ores = [
    { id: "quantainium", name: "Quantainium", aliases: ["quantanium", "qt"] },
    { id: "bexalite", name: "Bexalite", aliases: ["bex"] },
    { id: "agricium", name: "Agricium", aliases: [] },
  ];

  it("exact and prefix score high", () => {
    expect(fuzzyScore("bexalite", "Bexalite")).toBe(100);
    expect(fuzzyScore("bexa", "Bexalite")).toBeGreaterThanOrEqual(70);
  });

  it("typo still matches via best", () => {
    const hit = fuzzyBestMatch("bexalit", ores, (o) => [o.name, o.id, ...o.aliases], {
      minScore: 40,
    });
    expect(hit?.id).toBe("bexalite");
  });

  it("quantanium spelling lands on quantainium", () => {
    const hit = fuzzyBestMatch("quantanium", ores, (o) => [o.name, o.id, ...o.aliases]);
    expect(hit?.id).toBe("quantainium");
  });

  it("ranks better matches first", () => {
    const ranked = fuzzyRank("agri", ores, (o) => [o.name, o.id, ...o.aliases]);
    expect(ranked[0]?.item.id).toBe("agricium");
  });

  it("rejects garbage", () => {
    expect(
      fuzzyBestMatch("zzzznotanore", ores, (o) => [o.name, o.id], { minScore: 50 }),
    ).toBeUndefined();
  });
});
