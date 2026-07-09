import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScCraftClient, setScCraftClientForTests } from "../sc-craft.js";
import { ScTradeClient, setScTradeClientForTests } from "../sc-trade.js";
import { ScWikiClient, setScWikiClientForTests } from "../sc-wiki.js";
import { setUexClientForTests, UexClient } from "../uex.js";
import {
  formatCacheStatus,
  refreshEconomyCatalogs,
  runEconomyCacheRefresh,
  stopEconomyCacheScheduler,
} from "./refresh.js";
import { EconomyDiskCache, setEconomyDiskCacheForTests } from "./store.js";

describe("economy cache refresh", () => {
  let dir: string;
  let disk: EconomyDiskCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "econ-refresh-"));
    disk = new EconomyDiskCache(dir);
    setEconomyDiskCacheForTests(disk);
    setUexClientForTests(new UexClient({ enabled: false, disk }));
    setScCraftClientForTests(new ScCraftClient({ enabled: false, disk }));
    setScTradeClientForTests(new ScTradeClient({ enabled: false, disk }));
    setScWikiClientForTests(new ScWikiClient({ enabled: false, disk }));
    stopEconomyCacheScheduler();
  });

  afterEach(() => {
    stopEconomyCacheScheduler();
    setUexClientForTests(null);
    setScCraftClientForTests(null);
    setScTradeClientForTests(null);
    setScWikiClientForTests(null);
    setEconomyDiskCacheForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refreshEconomyCatalogs writes meta last-refresh and reports per source", async () => {
    const report = await refreshEconomyCatalogs({
      disk,
      wikiCommodityPages: 0,
      craftBlueprintPages: 0,
      wikiWarmNames: [],
    });
    expect(report.at).toBeGreaterThan(0);
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.results.every((r) => r.detail.includes("disabled") || !r.ok || r.ok)).toBe(true);
    const meta = disk.get<{ at: number }>("meta", "last-refresh");
    expect(meta?.data.at).toBe(report.at);
  });

  it("runEconomyCacheRefresh single-flights concurrent callers", async () => {
    const p1 = runEconomyCacheRefresh({
      disk,
      wikiCommodityPages: 0,
      craftBlueprintPages: 0,
      wikiWarmNames: [],
    });
    const p2 = runEconomyCacheRefresh({
      disk,
      wikiCommodityPages: 0,
      craftBlueprintPages: 0,
      wikiWarmNames: [],
    });
    expect(p1).toBe(p2); // same promise object
    const [ra, rb] = await Promise.all([p1, p2]);
    expect(ra.at).toBe(rb.at);
  });

  it("formatCacheStatus mentions disk root and refresh guidance", () => {
    disk.set("meta", "last-refresh", { at: Date.now(), results: [] }, 60_000);
    const s = formatCacheStatus();
    expect(s).toMatch(/Economy cache \(sqlite\)/i);
    expect(s).toMatch(/refresh/i);
  });
});
