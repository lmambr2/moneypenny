/**
 * Warm / refresh economy disk cache from remote catalogs.
 * Polite: limited pages, sequential sources, fail-soft per source.
 */
import axios from "axios";
import type { Logger } from "../../logger.js";
import { getScCraftClient } from "../sc-craft.js";
import { getScTradeClient } from "../sc-trade.js";
import { getScWikiClient } from "../sc-wiki.js";
import { getUexClient } from "../uex.js";
import { type EconomyDiskCache, getEconomyDiskCache } from "./store.js";

const USER_AGENT =
  "Moneypenny-OrgEconomy/1.0 (+https://github.com; economy-cache refresh; cache-friendly)";

export interface RefreshReport {
  at: number;
  ok: boolean;
  results: Array<{ source: string; key: string; ok: boolean; detail: string }>;
}

export interface RefreshOptions {
  disk?: EconomyDiskCache;
  logger?: Logger;
  /** Prefetch wiki commodity list pages (default 3). */
  wikiCommodityPages?: number;
  /** Prefetch sc-craft blueprint pages (default 2). */
  craftBlueprintPages?: number;
  /** Names to enrich via wiki search+detail (seed for doctrine). */
  wikiWarmNames?: string[];
}

const DEFAULT_WARM_NAMES = [
  "Quantainium",
  "Bexalite",
  "Agricium",
  "Stileron",
  "Hephaestanite",
  "Laranite",
  "Taranite",
  "P4-AR",
  "Coda",
  "Freelancer",
  "Caterpillar",
  "C2 Hercules",
];

/**
 * Pull high-value catalogs into disk cache. Safe to run on an interval.
 * Does not require SC_TRADE_API_TOKEN (only open catalog endpoints for trade).
 */
export async function refreshEconomyCatalogs(opts: RefreshOptions = {}): Promise<RefreshReport> {
  const disk = opts.disk ?? getEconomyDiskCache();
  const logger = opts.logger;
  const results: RefreshReport["results"] = [];
  const at = Date.now();

  // ── UEX commodities ──────────────────────────────────────────────────────
  try {
    const uex = getUexClient(logger);
    if (!uex.isEnabled()) {
      results.push({ source: "uex", key: "commodities", ok: false, detail: "disabled" });
    } else {
      const list = await uex.getCommodities();
      if (list) {
        disk.set("uex", "commodities", list, parseTtl("UEX_CACHE_TTL_MS", 6 * 3600_000));
        results.push({
          source: "uex",
          key: "commodities",
          ok: true,
          detail: `${list.length} commodities`,
        });
      } else {
        results.push({ source: "uex", key: "commodities", ok: false, detail: "fetch empty" });
      }
    }
  } catch (err) {
    results.push({
      source: "uex",
      key: "commodities",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ── sc-trade ships + locations (open GETs) ───────────────────────────────
  try {
    const trade = getScTradeClient(logger);
    if (!trade.isEnabled()) {
      results.push({ source: "sc-trade", key: "ships", ok: false, detail: "disabled" });
    } else {
      const ships = await trade.getShips();
      if (ships) {
        disk.set("sc-trade", "ships", ships, parseTtl("SCTRADE_CATALOG_TTL_MS", 6 * 3600_000));
        results.push({
          source: "sc-trade",
          key: "ships",
          ok: true,
          detail: `${ships.length} ships`,
        });
      } else {
        results.push({ source: "sc-trade", key: "ships", ok: false, detail: "fetch empty" });
      }
      const locs = await trade.getLocations();
      if (locs) {
        disk.set("sc-trade", "locations", locs, parseTtl("SCTRADE_CATALOG_TTL_MS", 6 * 3600_000));
        results.push({
          source: "sc-trade",
          key: "locations",
          ok: true,
          detail: `${locs.length} locations`,
        });
      }
    }
  } catch (err) {
    results.push({
      source: "sc-trade",
      key: "catalog",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ── sc-wiki version + warm names ─────────────────────────────────────────
  try {
    const wiki = getScWikiClient(logger);
    if (!wiki.isEnabled()) {
      results.push({ source: "sc-wiki", key: "warm", ok: false, detail: "disabled" });
    } else {
      const ver = await wiki.getGameVersion();
      results.push({
        source: "sc-wiki",
        key: "game-version",
        ok: !!ver,
        detail: ver ?? "missing",
      });

      // Commodity index pages (paginated carefully)
      const pages = Math.max(0, Math.min(10, opts.wikiCommodityPages ?? 3));
      let wikiComCount = 0;
      for (let page = 1; page <= pages; page++) {
        try {
          const { data } = await axios.get("https://api.star-citizen.wiki/api/commodities", {
            timeout: 15_000,
            headers: { Accept: "application/json", "User-Agent": USER_AGENT },
            params: { page, limit: 50 },
          });
          const list = Array.isArray(data?.data) ? data.data : [];
          wikiComCount += list.length;
          disk.set(
            "sc-wiki",
            `commodities:page:${page}`,
            list,
            parseTtl("SCWIKI_CACHE_TTL_MS", 12 * 3600_000),
          );
          if (list.length === 0) break;
          await sleep(200); // be polite
        } catch {
          break;
        }
      }
      results.push({
        source: "sc-wiki",
        key: "commodities-pages",
        ok: wikiComCount > 0,
        detail: `${wikiComCount} rows over ≤${pages} pages`,
      });

      const names = opts.wikiWarmNames ?? DEFAULT_WARM_NAMES;
      let warmed = 0;
      for (const name of names) {
        try {
          const text = await wiki.enrich(name);
          if (text) warmed += 1;
          await sleep(150);
        } catch {
          /* continue */
        }
      }
      results.push({
        source: "sc-wiki",
        key: "warm-names",
        ok: warmed > 0,
        detail: `${warmed}/${names.length} names enriched`,
      });
    }
  } catch (err) {
    results.push({
      source: "sc-wiki",
      key: "warm",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // ── sc-craft sample blueprint pages (open API) ───────────────────────────
  try {
    const craft = getScCraftClient(logger);
    if (!craft.isEnabled()) {
      results.push({ source: "sc-craft", key: "blueprints", ok: false, detail: "disabled" });
    } else {
      const pages = Math.max(0, Math.min(5, opts.craftBlueprintPages ?? 2));
      let n = 0;
      for (let page = 1; page <= pages; page++) {
        try {
          const { data } = await axios.get("https://sc-craft.tools/api/blueprints", {
            timeout: 12_000,
            headers: { Accept: "application/json", "User-Agent": USER_AGENT },
            params: { page, limit: 50 },
          });
          const items = Array.isArray(data?.items) ? data.items : [];
          n += items.length;
          disk.set(
            "sc-craft",
            `blueprints:page:${page}`,
            items,
            parseTtl("SCCRAFT_CACHE_TTL_MS", 6 * 3600_000),
          );
          if (items.length === 0) break;
          await sleep(200);
        } catch {
          break;
        }
      }
      // Warm a few searches used in examples
      for (const q of ["P4-AR", "Coda", "greatsword"]) {
        await craft.search(q, 8);
        await sleep(100);
      }
      results.push({
        source: "sc-craft",
        key: "blueprints",
        ok: n > 0,
        detail: `${n} blueprints cached + example searches`,
      });
    }
  } catch (err) {
    results.push({
      source: "sc-craft",
      key: "blueprints",
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  disk.set("meta", "last-refresh", { at, results }, 30 * 24 * 3600_000);

  const ok = results.some((r) => r.ok);
  logger?.info({ ok, results }, "economy cache refresh finished");
  return { at, ok, results };
}

function parseTtl(envKey: string, fallback: number): number {
  const n = parseInt(process.env[envKey] || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshInflight: Promise<RefreshReport> | null = null;

export function startEconomyCacheScheduler(opts: {
  intervalMs?: number;
  logger?: Logger;
  fireImmediately?: boolean;
}): void {
  stopEconomyCacheScheduler();
  const intervalMs =
    opts.intervalMs ?? (parseInt(process.env.ECONOMY_CACHE_REFRESH_MS || "", 10) || 6 * 3600_000);
  const run = () => {
    if (refreshInflight) return;
    refreshInflight = refreshEconomyCatalogs({ logger: opts.logger })
      .catch((err) => {
        opts.logger?.warn({ err }, "economy cache scheduled refresh failed");
        return {
          at: Date.now(),
          ok: false,
          results: [{ source: "scheduler", key: "error", ok: false, detail: String(err) }],
        } satisfies RefreshReport;
      })
      .finally(() => {
        refreshInflight = null;
      });
  };
  if (opts.fireImmediately !== false) {
    // Delay first warm so bot boot isn't blocked
    setTimeout(run, 15_000);
  }
  refreshTimer = setInterval(run, Math.max(60_000, intervalMs));
  // Don't keep process alive solely for refresh
  if (refreshTimer && typeof refreshTimer === "object" && "unref" in refreshTimer) {
    refreshTimer.unref();
  }
}

export function stopEconomyCacheScheduler(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export function formatCacheStatus(): string {
  const disk = getEconomyDiskCache();
  const stats = disk.stats();
  const last = disk.get<{ at: number; results: RefreshReport["results"] }>("meta", "last-refresh");
  const lines = [
    `Economy disk cache: ${stats.root}`,
    `Files: ${stats.totalFiles} · ~${Math.round(stats.totalBytes / 1024)} KB`,
  ];
  for (const s of stats.sources) {
    if (s.files === 0) continue;
    lines.push(`  ${s.source}: ${s.files} files (${s.fresh} fresh / ${s.stale} stale)`);
  }
  if (last?.data?.at) {
    const ageMin = Math.round((Date.now() - last.data.at) / 60_000);
    lines.push(`Last refresh: ~${ageMin} min ago`);
    for (const r of last.data.results.slice(0, 12)) {
      lines.push(`  ${r.ok ? "✓" : "○"} ${r.source}/${r.key}: ${r.detail}`);
    }
  } else {
    lines.push("Last refresh: never (will warm shortly after boot, or !econ refresh)");
  }
  lines.push("Refresh: automatic (ECONOMY_CACHE_REFRESH_MS, default 6h) or !econ refresh");
  return lines.join("\n");
}
