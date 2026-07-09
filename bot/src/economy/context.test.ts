import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EconomyDiskCache, setEconomyDiskCacheForTests } from "./cache/store.js";
import { economyContextForQuestion, isEconomyQuestion } from "./context.js";
import { setScWikiClientForTests, ScWikiClient } from "./sc-wiki.js";

describe("economyContextForQuestion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "econ-ctx-"));
    const disk = new EconomyDiskCache(dir);
    setEconomyDiskCacheForTests(disk);
    setScWikiClientForTests(new ScWikiClient({ enabled: true, disk }));
    // Pre-seed wiki cache as the scheduler would
    disk.set(
      "sc-wiki",
      "search:quantainium",
      [
        {
          name: "Quantainium",
          type: "items",
          api_url: "https://api.star-citizen.wiki/api/items/quantainium",
        },
      ],
      60_000,
    );
    disk.set(
      "sc-wiki",
      "items:quantainium",
      { name: "Quantainium", type: "Cargo", description: "Volatile ore." },
      60_000,
    );
  });

  afterEach(() => {
    setScWikiClientForTests(null);
    setEconomyDiskCacheForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

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

  it("includes wiki disk enrichment when present", () => {
    const chunks = economyContextForQuestion("what is quantainium cargo used for?");
    expect(chunks.some((c) => c.source.startsWith("economy/wiki-cache:"))).toBe(true);
    expect(chunks.some((c) => /Quantainium|api\.star-citizen\.wiki/i.test(c.text))).toBe(true);
  });
});
