/**
 * Optional UEX Corp API client — live commodity prices for economy.
 *
 * Policy:
 *  - Public JSON API (not HTML scrape of community UIs).
 *  - Polite defaults: long cache TTL, short timeout, identifiable User-Agent.
 *  - Fail soft: offline → null, never throw into command path.
 *  - Attribution required in user-facing replies.
 *  - Craft blueprints: see sc-craft.ts (sc-craft.tools).
 *
 * Docs: https://uexcorp.space/ — API host api.uexcorp.space
 */
import axios from "axios";
import type { Logger } from "../logger.js";
import { type EconomyDiskCache, getEconomyDiskCache } from "./cache/store.js";
import { fuzzyBestMatch, fuzzyScore } from "./fuzzy.js";

const DEFAULT_BASE = "https://api.uexcorp.space";
/** Org planning, not arb — SC major patches ~monthly. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Terminal prices — same long TTL; refresh manually after patches. */
const DEFAULT_PRICES_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_TIMEOUT_MS = 8_000;
const USER_AGENT = "Moneypenny-OrgEconomy/1.0 (+https://github.com; UEX client; cache-friendly)";

export const UEX_ATTRIBUTION = "Prices/commodity flags via UEX Corp API (uexcorp.space) — cached.";

export interface UexCommodity {
  id: number;
  name: string;
  code: string;
  kind?: string;
  is_raw?: number;
  is_refined?: number;
  is_mineral?: number;
  is_extractable?: number;
  is_refinable?: number;
  is_volatile_qt?: number;
  is_volatile_time?: number;
  is_available_live?: number;
  price_buy?: number;
  price_sell?: number;
  weight_scu?: number;
  wiki?: string;
}

/** Per-terminal row from /2.0/commodities_prices or commodities_prices_all. */
export interface UexTerminalPrice {
  id?: number;
  id_commodity?: number;
  id_terminal?: number;
  commodity_name?: string;
  terminal_name?: string;
  price_buy?: number;
  price_sell?: number;
  price_buy_avg?: number;
  price_sell_avg?: number;
  scu_sell_stock?: number;
  scu_sell_stock_avg?: number;
  scu_buy?: number;
  scu_sell?: number;
  status_buy?: number;
  status_sell?: number;
  container_sizes?: string;
  quality?: number;
}

export interface UexTerminalOffer {
  name: string;
  price: number;
  stock?: number;
  stockAvg?: number;
}

/** Supply hint derived from terminal stock vs average (E-UEX-SUP). */
export interface UexSupplyHint {
  /** Median stock/avg × 100 across sell terminals with data; null if unknown. */
  supplyPct: number | null;
  sellTerminals: UexTerminalOffer[];
  buyTerminals: UexTerminalOffer[];
  sampleSize: number;
}

export interface UexPriceSnapshot {
  commodity: UexCommodity;
  /** Best non-zero sell price among raw+refined matches for the query name. */
  sell: number | null;
  buy: number | null;
  matches: UexCommodity[];
  fetchedAt: number;
  attribution: string;
  /** Optional terminal supply enrichment (fail-open if prices endpoint empty). */
  supply?: UexSupplyHint | null;
}

export interface UexClientOptions {
  /** Default true unless ECONOMY_UEX=0 / false / off. */
  enabled?: boolean;
  baseUrl?: string;
  ttlMs?: number;
  /** TTL for per-commodity terminal prices (default 7d). */
  pricesTtlMs?: number;
  timeoutMs?: number;
  /** Optional API key (Bearer / header if UEX requires it later). */
  apiKey?: string;
  logger?: Logger;
  disk?: EconomyDiskCache;
  /** Inject for tests. */
  fetchCommodities?: () => Promise<UexCommodity[]>;
  /** Inject terminal prices for a commodity id (tests). */
  fetchTerminalPrices?: (commodityId: number) => Promise<UexTerminalPrice[]>;
}

function envEnabled(): boolean {
  const v = (process.env.ECONOMY_UEX ?? process.env.UEX_ENABLED ?? "1").toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\(raw\)|\(ore\)|\(refined\)/gi, "")
    .replace(/[^a-z0-9]+/g, "");
}

export class UexClient {
  private enabled: boolean;
  private baseUrl: string;
  private ttlMs: number;
  private pricesTtlMs: number;
  private timeoutMs: number;
  private apiKey?: string;
  private logger?: Logger;
  private disk: EconomyDiskCache;
  private fetchCommodities?: () => Promise<UexCommodity[]>;
  private fetchTerminalPrices?: (commodityId: number) => Promise<UexTerminalPrice[]>;

  private cache: { at: number; data: UexCommodity[] } | null = null;
  private inflight: Promise<UexCommodity[]> | null = null;
  private terminalCache = new Map<number, { at: number; data: UexTerminalPrice[] }>();
  private terminalInflight = new Map<number, Promise<UexTerminalPrice[]>>();

  constructor(opts: UexClientOptions = {}) {
    this.enabled = opts.enabled ?? envEnabled();
    this.baseUrl = (opts.baseUrl ?? process.env.UEX_API_BASE ?? DEFAULT_BASE).replace(/\/$/, "");
    this.ttlMs = opts.ttlMs ?? (parseInt(process.env.UEX_CACHE_TTL_MS || "", 10) || DEFAULT_TTL_MS);
    this.pricesTtlMs =
      opts.pricesTtlMs ??
      (parseInt(process.env.UEX_PRICES_CACHE_TTL_MS || "", 10) || DEFAULT_PRICES_TTL_MS);
    this.timeoutMs =
      opts.timeoutMs ?? (parseInt(process.env.UEX_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS);
    this.apiKey = opts.apiKey ?? process.env.UEX_API_KEY ?? undefined;
    this.logger = opts.logger;
    this.disk = opts.disk ?? getEconomyDiskCache();
    this.fetchCommodities = opts.fetchCommodities;
    this.fetchTerminalPrices = opts.fetchTerminalPrices;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Drop cache (tests / admin). */
  clearCache(): void {
    this.cache = null;
    this.terminalCache.clear();
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
      headers["Authorization-Api"] = this.apiKey;
    }
    return headers;
  }

  async getCommodities(): Promise<UexCommodity[] | null> {
    if (!this.enabled) return null;
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.data;
    const diskHit = this.disk.get<UexCommodity[]>("uex", "commodities", now);
    if (diskHit && !diskHit.stale) {
      this.cache = { at: diskHit.fetchedAt, data: diskHit.data };
      return diskHit.data;
    }
    // Stale-while-revalidate: serve expired L2 immediately, refresh in background.
    if (diskHit?.stale && diskHit.data) {
      this.cache = { at: diskHit.fetchedAt, data: diskHit.data };
      if (!this.inflight) {
        this.inflight = this.loadCommodities()
          .then((data) => {
            this.cache = { at: Date.now(), data };
            this.disk.set("uex", "commodities", data, this.ttlMs);
            return data;
          })
          .catch((err) => {
            this.logger?.warn({ err }, "UEX commodities SWR refresh failed");
            return diskHit.data;
          })
          .finally(() => {
            this.inflight = null;
          });
      }
      return diskHit.data;
    }
    if (this.inflight) {
      try {
        return await this.inflight;
      } catch {
        return this.cache?.data ?? diskHit?.data ?? null;
      }
    }
    this.inflight = this.loadCommodities()
      .then((data) => {
        this.cache = { at: Date.now(), data };
        this.disk.set("uex", "commodities", data, this.ttlMs);
        return data;
      })
      .finally(() => {
        this.inflight = null;
      });
    try {
      return await this.inflight;
    } catch (err) {
      this.logger?.warn({ err }, "UEX commodities fetch failed");
      return this.cache?.data ?? diskHit?.data ?? null;
    }
  }

  private async loadCommodities(): Promise<UexCommodity[]> {
    if (this.fetchCommodities) return this.fetchCommodities();
    const url = `${this.baseUrl}/2.0/commodities`;
    const { data } = await axios.get(url, {
      timeout: this.timeoutMs,
      headers: this.authHeaders(),
    });
    const list = (data?.data ?? data) as UexCommodity[];
    if (!Array.isArray(list)) throw new Error("UEX commodities: unexpected payload");
    this.logger?.debug({ count: list.length }, "UEX commodities cached");
    return list;
  }

  /**
   * Terminal prices for one commodity id — `/2.0/commodities_prices?id_commodity=`.
   * Long TTL (default 7d). Fail-soft → empty array.
   */
  async getTerminalPrices(commodityId: number): Promise<UexTerminalPrice[]> {
    if (!this.enabled || !Number.isFinite(commodityId) || commodityId <= 0) return [];
    const now = Date.now();
    const mem = this.terminalCache.get(commodityId);
    if (mem && now - mem.at < this.pricesTtlMs) return mem.data;

    const diskKey = `prices:${commodityId}`;
    const diskHit = this.disk.get<UexTerminalPrice[]>("uex", diskKey, now);
    if (diskHit && !diskHit.stale) {
      this.terminalCache.set(commodityId, { at: diskHit.fetchedAt, data: diskHit.data });
      return diskHit.data;
    }
    if (diskHit?.stale && diskHit.data) {
      this.terminalCache.set(commodityId, { at: diskHit.fetchedAt, data: diskHit.data });
      if (!this.terminalInflight.has(commodityId)) {
        void this.loadTerminalPrices(commodityId)
          .then((data) => {
            this.terminalCache.set(commodityId, { at: Date.now(), data });
            this.disk.set("uex", diskKey, data, this.pricesTtlMs);
          })
          .catch((err) => {
            this.logger?.warn({ err, commodityId }, "UEX terminal prices SWR failed");
          })
          .finally(() => {
            this.terminalInflight.delete(commodityId);
          });
      }
      return diskHit.data;
    }

    const inflight = this.terminalInflight.get(commodityId);
    if (inflight) {
      try {
        return await inflight;
      } catch {
        return mem?.data ?? diskHit?.data ?? [];
      }
    }

    const load = this.loadTerminalPrices(commodityId)
      .then((data) => {
        this.terminalCache.set(commodityId, { at: Date.now(), data });
        this.disk.set("uex", diskKey, data, this.pricesTtlMs);
        return data;
      })
      .finally(() => {
        this.terminalInflight.delete(commodityId);
      });
    this.terminalInflight.set(commodityId, load);
    try {
      return await load;
    } catch (err) {
      this.logger?.warn({ err, commodityId }, "UEX terminal prices fetch failed");
      return mem?.data ?? diskHit?.data ?? [];
    }
  }

  private async loadTerminalPrices(commodityId: number): Promise<UexTerminalPrice[]> {
    if (this.fetchTerminalPrices) return this.fetchTerminalPrices(commodityId);
    const url = `${this.baseUrl}/2.0/commodities_prices`;
    const { data } = await axios.get(url, {
      timeout: this.timeoutMs,
      headers: this.authHeaders(),
      params: { id_commodity: commodityId },
    });
    const list = (data?.data ?? data) as UexTerminalPrice[];
    if (!Array.isArray(list)) throw new Error("UEX commodities_prices: unexpected payload");
    this.logger?.debug({ commodityId, count: list.length }, "UEX terminal prices cached");
    return list;
  }

  /** Build supply hint from terminal rows (pure; exported for tests via method). */
  buildSupplyHint(rows: UexTerminalPrice[]): UexSupplyHint {
    const sellOffers: UexTerminalOffer[] = [];
    const buyOffers: UexTerminalOffer[] = [];
    const ratios: number[] = [];

    for (const r of rows) {
      const term = (r.terminal_name || "").trim() || `terminal#${r.id_terminal ?? "?"}`;
      const sell = Number(r.price_sell ?? 0);
      const buy = Number(r.price_buy ?? 0);
      const stock = Number(r.scu_sell_stock ?? 0);
      const stockAvg = Number(r.scu_sell_stock_avg ?? 0);
      if (sell > 0) {
        sellOffers.push({
          name: term,
          price: sell,
          stock: stock > 0 ? stock : undefined,
          stockAvg: stockAvg > 0 ? stockAvg : undefined,
        });
        if (stock > 0 && stockAvg > 0) ratios.push((stock / stockAvg) * 100);
      }
      if (buy > 0) {
        buyOffers.push({ name: term, price: buy });
      }
    }

    // Best sell = highest price; best buy = lowest price
    sellOffers.sort((a, b) => b.price - a.price);
    buyOffers.sort((a, b) => a.price - b.price);

    let supplyPct: number | null = null;
    if (ratios.length > 0) {
      const sorted = [...ratios].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      supplyPct = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
      supplyPct = Math.round(supplyPct * 10) / 10;
    }

    return {
      supplyPct,
      sellTerminals: sellOffers.slice(0, 8),
      buyTerminals: buyOffers.slice(0, 8),
      sampleSize: rows.length,
    };
  }

  /**
   * Resolve price snapshot for an ore/commodity name.
   * Matches both "Bexalite" and "Bexalite (Raw)" etc. (+ E-FUZZY fallback).
   * Enriches with terminal supply when prices endpoint is available (E-UEX-SUP).
   */
  async lookupPrice(query: string): Promise<UexPriceSnapshot | null> {
    const list = await this.getCommodities();
    if (!list) return null;
    const q = norm(query);
    if (!q) return null;

    let matches = list.filter((c) => {
      const n = norm(c.name || "");
      const code = (c.code || "").toLowerCase();
      return n === q || n.includes(q) || q.includes(n) || code === q;
    });

    // Fuzzy fallback when substring match empty
    if (matches.length === 0) {
      const fuzzyHit = fuzzyBestMatch(query, list, (c) => [c.name || "", c.code || ""], {
        minScore: 50,
        minQueryLen: 3,
      });
      if (fuzzyHit) {
        // Include all commodities that score well against the same fuzzy hit name
        const base = norm(fuzzyHit.name || "");
        matches = list.filter((c) => {
          const n = norm(c.name || "");
          return (
            n === base ||
            n.includes(base) ||
            base.includes(n) ||
            fuzzyScore(query, c.name || "", [c.code || ""], { minQueryLen: 3 }) >= 50
          );
        });
        if (matches.length === 0) matches = [fuzzyHit];
      }
    }
    if (matches.length === 0) return null;

    // Prefer refined (is_raw=0) sell prices for "what is X worth", but keep raw rows.
    const refined = matches.filter((m) => !m.is_raw);
    const pool = refined.length > 0 ? refined : matches;
    const bestSell = pool.reduce<number | null>((acc, m) => {
      const p = m.price_sell ?? 0;
      if (p <= 0) return acc;
      return acc == null || p > acc ? p : acc;
    }, null);
    const bestBuy = pool.reduce<number | null>((acc, m) => {
      const p = m.price_buy ?? 0;
      if (p <= 0) return acc;
      return acc == null || p < acc ? p : acc;
    }, null);

    const primary =
      pool.find((m) => (m.price_sell ?? 0) === bestSell && (m.price_sell ?? 0) > 0) ?? pool[0]!;

    let supply: UexSupplyHint | null = null;
    try {
      const rows = await this.getTerminalPrices(primary.id);
      if (rows.length > 0) supply = this.buildSupplyHint(rows);
    } catch {
      supply = null;
    }

    return {
      commodity: primary,
      sell: bestSell,
      buy: bestBuy,
      matches,
      fetchedAt: this.cache?.at ?? Date.now(),
      attribution: UEX_ATTRIBUTION,
      supply,
    };
  }
}

/** Singleton for command handlers (lazy). Tests can construct UexClient directly. */
let defaultClient: UexClient | null = null;

export function getUexClient(logger?: Logger): UexClient {
  if (!defaultClient) defaultClient = new UexClient({ logger });
  return defaultClient;
}

/** Test helper. */
export function setUexClientForTests(client: UexClient | null): void {
  defaultClient = client;
}
