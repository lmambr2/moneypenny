import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EconomyDiskCache, setEconomyDiskCacheForTests } from "./store.js";

describe("EconomyDiskCache (SQLite)", () => {
  let dir: string;
  let cache: EconomyDiskCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "econ-sql-"));
    cache = new EconomyDiskCache(dir); // → dir/economy-cache.db
    setEconomyDiskCacheForTests(cache);
  });
  afterEach(() => {
    setEconomyDiskCacheForTests(null);
    cache.close();
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

  it("stats counts rows", () => {
    cache.set("sc-trade", "ships", [{ name: "Freelancer" }], 60_000);
    const s = cache.stats();
    expect(s.backend).toBe("sqlite");
    expect(s.totalFiles).toBeGreaterThanOrEqual(1);
    expect(s.sources.some((x) => x.source === "sc-trade" && x.files >= 1)).toBe(true);
  });

  it("shares table when constructed with open Database", () => {
    const db = new Database(":memory:");
    const a = new EconomyDiskCache(db);
    a.set("meta", "k", { v: 1 }, 60_000);
    const b = new EconomyDiskCache(db);
    expect(b.getFresh<{ v: number }>("meta", "k")?.v).toBe(1);
    a.close(); // does not close shared db
    b.close();
    db.close();
  });

  it("migrates legacy JSON files from directory", () => {
    const legacy = mkdtempSync(join(tmpdir(), "econ-json-"));
    try {
      const sdir = join(legacy, "uex");
      mkdirSync(sdir, { recursive: true });
      const now = Date.now();
      writeFileSync(
        join(sdir, "commodities.json"),
        JSON.stringify({
          source: "uex",
          key: "commodities",
          fetchedAt: now,
          expiresAt: now + 3600_000,
          data: [{ name: "Agricium", code: "AGRI" }],
        }),
      );
      const n = cache.migrateLegacyJsonDir(legacy);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(cache.getFresh<{ name: string }[]>("uex", "commodities")?.[0]?.name).toBe("Agricium");
    } finally {
      rmSync(legacy, { recursive: true, force: true });
    }
  });

  it("delete and clear", () => {
    cache.set("meta", "a", 1, 60_000);
    cache.set("meta", "b", 2, 60_000);
    expect(cache.delete("meta", "a")).toBe(true);
    expect(cache.get("meta", "a")).toBeNull();
    expect(cache.clear("meta")).toBe(1);
  });
});
