import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EconomyDiskCache, setEconomyDiskCacheForTests } from "./cache/store.js";
import { UexClient } from "./uex.js";

describe("UexClient", () => {
  let dir: string;
  let disk: EconomyDiskCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uex-"));
    disk = new EconomyDiskCache(dir);
    setEconomyDiskCacheForTests(disk);
  });

  afterEach(() => {
    setEconomyDiskCacheForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("is disabled via constructor flag", async () => {
    const c = new UexClient({ enabled: false, disk });
    expect(c.isEnabled()).toBe(false);
    expect(await c.getCommodities()).toBeNull();
    expect(await c.lookupPrice("bexalite")).toBeNull();
  });

  it("lookupPrice prefers refined sell and matches aliases", async () => {
    const c = new UexClient({
      enabled: true,
      disk,
      fetchCommodities: async () => [
        {
          id: 1,
          name: "Bexalite (Raw)",
          code: "BEXR",
          is_raw: 1,
          price_sell: 1000,
          price_buy: 500,
        },
        {
          id: 2,
          name: "Bexalite",
          code: "BEXA",
          is_raw: 0,
          price_sell: 28000,
          price_buy: 20000,
        },
      ],
      fetchTerminalPrices: async () => [],
    });
    const snap = await c.lookupPrice("bex");
    expect(snap).not.toBeNull();
    expect(snap!.sell).toBe(28000);
    expect(snap!.buy).toBe(20000);
    expect(snap!.commodity.name).toBe("Bexalite");
    expect(snap!.matches.length).toBe(2);
    expect(snap!.attribution).toMatch(/UEX/i);

    expect(await c.lookupPrice("no-such-commodity-xyz")).toBeNull();
    expect(await c.lookupPrice("")).toBeNull();
  });

  it("enriches supply from terminal prices (E-UEX-SUP)", async () => {
    const c = new UexClient({
      enabled: true,
      disk,
      fetchCommodities: async () => [
        { id: 10, name: "Aluminum", code: "ALUM", is_raw: 0, price_sell: 4000, price_buy: 2000 },
      ],
      fetchTerminalPrices: async (id) => {
        expect(id).toBe(10);
        return [
          {
            id_commodity: 10,
            terminal_name: "TDD Area 18",
            price_sell: 4200,
            scu_sell_stock: 50,
            scu_sell_stock_avg: 100,
          },
          {
            id_commodity: 10,
            terminal_name: "Port Tressler",
            price_sell: 3800,
            scu_sell_stock: 80,
            scu_sell_stock_avg: 100,
          },
          {
            id_commodity: 10,
            terminal_name: "Grim HEX",
            price_buy: 1500,
          },
        ];
      },
    });
    const snap = await c.lookupPrice("aluminum");
    expect(snap?.supply?.sampleSize).toBe(3);
    expect(snap?.supply?.supplyPct).toBe(65); // median of 50% and 80%
    expect(snap?.supply?.sellTerminals[0]?.name).toBe("TDD Area 18"); // highest sell
    expect(snap?.supply?.buyTerminals[0]?.price).toBe(1500);
  });

  it("fuzzy matches commodity typos", async () => {
    const c = new UexClient({
      enabled: true,
      disk,
      fetchCommodities: async () => [
        { id: 3, name: "Agricium", code: "AGRI", is_raw: 0, price_sell: 9000 },
      ],
      fetchTerminalPrices: async () => [],
    });
    const snap = await c.lookupPrice("agricum");
    expect(snap?.commodity.name).toBe("Agricium");
  });

  it("caches commodities list in memory", async () => {
    let calls = 0;
    const c = new UexClient({
      enabled: true,
      disk,
      ttlMs: 60_000,
      fetchCommodities: async () => {
        calls += 1;
        return [{ id: 1, name: "Agricium", code: "AGRI", price_sell: 9000 }];
      },
    });
    await c.getCommodities();
    await c.getCommodities();
    expect(calls).toBe(1);
    c.clearCache();
    // After memory clear, disk still has fresh entry — still no second network fetch.
    await c.getCommodities();
    expect(calls).toBe(1);
    // Force miss by clearing disk commodities key
    disk.delete("uex", "commodities");
    c.clearCache();
    await c.getCommodities();
    expect(calls).toBe(2);
  });
});
