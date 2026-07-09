/**
 * Optional UEX Corp API client — the only third-party *machine* feed for economy.
 *
 * Policy:
 *  - Public JSON API (not HTML scrape of community UIs).
 *  - Polite defaults: long cache TTL, short timeout, identifiable User-Agent.
 *  - Fail soft: offline → null, never throw into command path.
 *  - Attribution required in user-facing replies.
 *
 * Docs: https://uexcorp.space/ — API host api.uexcorp.space
 */
import axios from "axios";
import type { Logger } from "../logger.js";

const DEFAULT_BASE = "https://api.uexcorp.space";
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
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

export interface UexPriceSnapshot {
  commodity: UexCommodity;
  /** Best non-zero sell price among raw+refined matches for the query name. */
  sell: number | null;
  buy: number | null;
  matches: UexCommodity[];
  fetchedAt: number;
  attribution: string;
}

export interface UexClientOptions {
  /** Default true unless ECONOMY_UEX=0 / false / off. */
  enabled?: boolean;
  baseUrl?: string;
  ttlMs?: number;
  timeoutMs?: number;
  /** Optional API key (Bearer / header if UEX requires it later). */
  apiKey?: string;
  logger?: Logger;
  /** Inject for tests. */
  fetchCommodities?: () => Promise<UexCommodity[]>;
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
  private timeoutMs: number;
  private apiKey?: string;
  private logger?: Logger;
  private fetchCommodities?: () => Promise<UexCommodity[]>;

  private cache: { at: number; data: UexCommodity[] } | null = null;
  private inflight: Promise<UexCommodity[]> | null = null;

  constructor(opts: UexClientOptions = {}) {
    this.enabled = opts.enabled ?? envEnabled();
    this.baseUrl = (opts.baseUrl ?? process.env.UEX_API_BASE ?? DEFAULT_BASE).replace(/\/$/, "");
    this.ttlMs = opts.ttlMs ?? (parseInt(process.env.UEX_CACHE_TTL_MS || "", 10) || DEFAULT_TTL_MS);
    this.timeoutMs =
      opts.timeoutMs ?? (parseInt(process.env.UEX_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS);
    this.apiKey = opts.apiKey ?? process.env.UEX_API_KEY ?? undefined;
    this.logger = opts.logger;
    this.fetchCommodities = opts.fetchCommodities;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Drop cache (tests / admin). */
  clearCache(): void {
    this.cache = null;
  }

  async getCommodities(): Promise<UexCommodity[] | null> {
    if (!this.enabled) return null;
    const now = Date.now();
    if (this.cache && now - this.cache.at < this.ttlMs) return this.cache.data;
    if (this.inflight) {
      try {
        return await this.inflight;
      } catch {
        return this.cache?.data ?? null;
      }
    }
    this.inflight = this.loadCommodities()
      .then((data) => {
        this.cache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        this.inflight = null;
      });
    try {
      return await this.inflight;
    } catch (err) {
      this.logger?.warn({ err }, "UEX commodities fetch failed");
      return this.cache?.data ?? null;
    }
  }

  private async loadCommodities(): Promise<UexCommodity[]> {
    if (this.fetchCommodities) return this.fetchCommodities();
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
      // Some UEX docs also accept a dedicated header — send both when key present.
      headers["Authorization-Api"] = this.apiKey;
    }
    const url = `${this.baseUrl}/2.0/commodities`;
    const { data } = await axios.get(url, { timeout: this.timeoutMs, headers });
    const list = (data?.data ?? data) as UexCommodity[];
    if (!Array.isArray(list)) throw new Error("UEX commodities: unexpected payload");
    this.logger?.debug({ count: list.length }, "UEX commodities cached");
    return list;
  }

  /**
   * Resolve price snapshot for an ore/commodity name.
   * Matches both "Bexalite" and "Bexalite (Raw)" etc.
   */
  async lookupPrice(query: string): Promise<UexPriceSnapshot | null> {
    const list = await this.getCommodities();
    if (!list) return null;
    const q = norm(query);
    if (!q) return null;

    const matches = list.filter((c) => {
      const n = norm(c.name || "");
      const code = (c.code || "").toLowerCase();
      return n === q || n.includes(q) || q.includes(n) || code === q;
    });
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

    return {
      commodity: primary,
      sell: bestSell,
      buy: bestBuy,
      matches,
      fetchedAt: this.cache?.at ?? Date.now(),
      attribution: UEX_ATTRIBUTION,
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
