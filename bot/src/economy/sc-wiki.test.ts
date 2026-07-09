import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EconomyDiskCache } from "./cache/store.js";
import { formatWikiSnippet, ScWikiClient } from "./sc-wiki.js";

describe("ScWikiClient + disk cache", () => {
  let dir: string;
  let disk: EconomyDiskCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scwiki-"));
    disk = new EconomyDiskCache(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("search caches to disk and readCachedEnrichment is offline", async () => {
    const client = new ScWikiClient({
      enabled: true,
      disk,
      fetchSearch: async () => [
        {
          name: "Quantainium",
          type: "items",
          api_url: "https://api.star-citizen.wiki/api/items/quantainium",
        },
      ],
      fetchJson: async () => ({
        name: "Quantainium",
        type: "Cargo",
        description: "Volatile mining commodity.",
      }),
    });
    const hits = await client.search("quantainium");
    expect(hits?.[0]?.name).toBe("Quantainium");
    await client.enrich("quantainium");
    const offline = client.readCachedEnrichment("quantainium");
    expect(offline).toMatch(/Quantainium/);
    expect(offline).toMatch(/api\.star-citizen\.wiki/i);
  });

  it("formatWikiSnippet includes BOM lines", () => {
    const text = formatWikiSnippet(
      { name: "Omnisky III", type: "blueprints" },
      {
        output_name: "Omnisky III Cannon",
        craft_time_seconds: 540,
        ingredients: [{ name: "Agricium", quantity_scu: 0.36 }],
      },
    );
    expect(text).toMatch(/Agricium/);
    expect(text).toMatch(/9 min/);
  });
});
