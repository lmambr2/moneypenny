import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EconomyDiskCache, setEconomyDiskCacheForTests } from "./cache/store.js";
import {
  IngestStore,
  IngestValidationError,
  parseTerminalSnapshot,
  setIngestStoreForTests,
} from "./ingest.js";
import { UexClient } from "./uex.js";

const sampleBody = {
  source: "datarunner",
  game_version: "4.10.0",
  environment: "LIVE",
  id_terminal: 89,
  terminal_name: "Area 18 TDD",
  type: "commodity",
  prices: [
    {
      id_commodity: 1,
      name: "Agricium",
      price_buy: 4000,
      price_sell: 12000,
      scu_buy: 100,
      scu_sell: 50,
      status_buy: 4,
      status_sell: 3,
    },
  ],
  screenshot_sha256: "a".repeat(64),
  captured_at: 1_700_000_000_000,
};

describe("parseTerminalSnapshot", () => {
  it("accepts a valid commodity snapshot", () => {
    const p = parseTerminalSnapshot(sampleBody);
    expect(p.idTerminal).toBe(89);
    expect(p.prices).toHaveLength(1);
    expect(p.prices[0]!.name).toBe("Agricium");
  });

  it("rejects missing prices and bad types", () => {
    expect(() => parseTerminalSnapshot({})).toThrow(IngestValidationError);
    expect(() => parseTerminalSnapshot({ ...sampleBody, type: "nope" })).toThrow(/type/);
    expect(() => parseTerminalSnapshot({ ...sampleBody, environment: "EU" })).toThrow(
      /environment/,
    );
    expect(() => parseTerminalSnapshot({ ...sampleBody, screenshot_sha256: "zz" })).toThrow(
      /screenshot_sha256/,
    );
  });

  it("accepts fuel as a Moneypenny-local type", () => {
    const p = parseTerminalSnapshot({
      ...sampleBody,
      type: "fuel",
      prices: [{ name: "Hydrogen", price_sell: 2.1 }],
    });
    expect(p.type).toBe("fuel");
  });
});

describe("IngestStore + UEX precedence", () => {
  let db: Database.Database;
  let disk: EconomyDiskCache;
  let store: IngestStore;

  beforeEach(() => {
    db = new Database(":memory:");
    disk = new EconomyDiskCache(":memory:");
    setEconomyDiskCacheForTests(disk);
    store = new IngestStore(db, disk);
    setIngestStoreForTests(store);
  });

  afterEach(() => {
    setIngestStoreForTests(null);
    setEconomyDiskCacheForTests(null);
    db.close();
    disk.close();
  });

  it("stores snapshots and looks up overlays by name", () => {
    const parsed = parseTerminalSnapshot(sampleBody);
    store.add(parsed, { createdBy: "lane" });
    expect(store.hasAccepted()).toBe(true);
    const overlay = store.lookupOverlay("agricium");
    expect(overlay).not.toBeNull();
    expect(overlay!.sell).toBe(12000);
    expect(overlay!.buy).toBe(4000);
    expect(overlay!.rows[0]!.terminal_name).toMatch(/Area 18/);
  });

  it("lookupPrice prefers a newer local snapshot over UEX", async () => {
    const now = Date.now();
    store.add(parseTerminalSnapshot({ ...sampleBody, captured_at: now + 60_000 }));
    const uex = new UexClient({
      enabled: true,
      disk,
      fetchCommodities: async () => [
        { id: 1, name: "Agricium", code: "AGRI", is_raw: 0, price_sell: 9000, price_buy: 5000 },
      ],
      fetchTerminalPrices: async () => [
        { id_commodity: 1, terminal_name: "UEX old", price_sell: 9000, price_buy: 5000 },
      ],
    });
    const snap = await uex.lookupPrice("Agricium");
    expect(snap?.source).toBe("local");
    expect(snap?.sell).toBe(12000);
    expect(snap?.attribution).toMatch(/Local terminal snapshot/i);
  });

  it("lookupPrice falls back to UEX when local is older", async () => {
    store.add(parseTerminalSnapshot({ ...sampleBody, captured_at: 1_000 }));
    const uex = new UexClient({
      enabled: true,
      disk,
      fetchCommodities: async () => [
        { id: 1, name: "Agricium", code: "AGRI", is_raw: 0, price_sell: 9000, price_buy: 5000 },
      ],
      fetchTerminalPrices: async () => [],
    });
    const snap = await uex.lookupPrice("Agricium");
    expect(snap?.source).toBe("uex");
    expect(snap?.sell).toBe(9000);
  });

  it("lookupPrice works with UEX disabled when a local snapshot exists", async () => {
    store.add(parseTerminalSnapshot(sampleBody));
    const uex = new UexClient({ enabled: false, disk });
    const snap = await uex.lookupPrice("Agricium");
    expect(snap?.source).toBe("local");
    expect(snap?.sell).toBe(12000);
  });

  it("reject drops the overlay", () => {
    const row = store.add(parseTerminalSnapshot(sampleBody));
    store.setStatus(row.id, "rejected");
    expect(store.lookupOverlay("agricium")).toBeNull();
  });
});
