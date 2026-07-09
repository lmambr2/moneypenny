import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EconomyDiskCache } from "./store.js";

describe("EconomyDiskCache", () => {
  let dir: string;
  let cache: EconomyDiskCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "econ-cache-"));
    cache = new EconomyDiskCache(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips fresh data", () => {
    cache.set("uex", "commodities", [{ name: "Bexalite" }], 60_000);
    const hit = cache.getFresh<{ name: string }[]>("uex", "commodities");
    expect(hit?.[0]?.name).toBe("Bexalite");
    expect(cache.get("uex", "commodities")?.stale).toBe(false);
  });

  it("marks expired entries stale but still readable", () => {
    cache.set("sc-wiki", "item:quantainium", { name: "Quantainium" }, 1);
    const past = Date.now() + 1000;
    const hit = cache.get<{ name: string }>("sc-wiki", "item:quantainium", past);
    expect(hit?.stale).toBe(true);
    expect(hit?.data.name).toBe("Quantainium");
    expect(cache.getFresh("sc-wiki", "item:quantainium", past)).toBeNull();
  });

  it("stats counts files", () => {
    cache.set("sc-trade", "ships", [{ name: "Freelancer" }], 60_000);
    const s = cache.stats();
    expect(s.totalFiles).toBeGreaterThanOrEqual(1);
    expect(s.sources.some((x) => x.source === "sc-trade" && x.files >= 1)).toBe(true);
  });
});
