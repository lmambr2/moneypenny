/**
 * Optional SC Trade Tools client — trade routes, itineraries, best buyers.
 *
 * Policy (docs/economy.md):
 *  - Official public REST API (OpenAPI / Swagger) — not HTML scrape.
 *  - Trade tools require a licence token (header `token`); catalog GETs are open.
 *  - Polite defaults: cache, short timeout, identifiable User-Agent.
 *  - Fail soft; attribution on every reply.
 *  - Community-reported prices (not CIG live market).
 *
 * Docs: https://sc-trade.tools/swagger-ui/index.html
 * Licence: https://www.patreon.com/cw/sc_trade_tools/membership
 */
import axios, { type AxiosError } from "axios";
import type { Logger } from "../logger.js";

const DEFAULT_BASE = "https://sc-trade.tools";
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min for route results
const DEFAULT_CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // 6h for ships/locations
const DEFAULT_TIMEOUT_MS = 45_000; // route search can be heavy
const USER_AGENT =
  "Moneypenny-OrgEconomy/1.0 (+https://github.com; sc-trade.tools client; cache-friendly)";

export const SC_TRADE_ATTRIBUTION =
  "Trade data via SC Trade Tools (sc-trade.tools) — community reports, cached. Not CIG.";

export type ListMode = "blacklist" | "whitelist";
export type ProfitType = "time" | "pure";

export interface ScTradeTransaction {
  location?: string;
  shop?: string;
  securityLevel?: number;
  faction?: string;
  action?: string;
  itemQuantityInScu?: number;
  itemName?: string;
  price?: number;
  fees?: number;
  quantityInScu?: number;
  maxQuantityInScu?: number;
  locationAndShop?: string;
}

export interface ScTradeRoute {
  id?: number;
  origin?: ScTradeTransaction;
  destination?: ScTradeTransaction;
  profitPerMinute?: number;
  profit?: number;
  timeInSeconds?: number;
}

export interface ScTradeShip {
  name: string;
  maxBoxSizeInScu?: number;
}

export interface TradeSearchOpts {
  ship: string;
  investment: number;
  maxStops?: number;
  profitType?: ProfitType;
  supportedBoxSizeInScu?: number;
  minSecurityLevel?: number;
  minInventorySizeInScu?: number;
  /** Whitelist location name prefixes (e.g. "Stanton"). */
  locationInclude?: string[];
  /** Explicit full location names to whitelist. */
  locationNames?: string[];
  commodityInclude?: string[];
  originShop?: string;
  allowWaitTimes?: boolean;
  useAutoLoading?: boolean;
  smartFilters?: boolean;
  avoidHiddenLocations?: boolean;
  maxResults?: number;
}

export interface ItineraryOpts extends TradeSearchOpts {
  origin: string;
  destination: string;
  allowableDetour?: number;
}

export interface BuyersOpts {
  commodityName: string;
  commodityQuantityInScu: number;
  supportedBoxSizeInScu?: number;
  minSecurityLevel?: number;
  minInventorySizeInScu?: number;
  locationInclude?: string[];
  isCargoStolen?: boolean;
  allowWaitTimes?: boolean;
  avoidHiddenLocations?: boolean;
  maxResults?: number;
}

export interface ScTradeClientOptions {
  enabled?: boolean;
  baseUrl?: string;
  /** API licence token (header `token`). Required for /api/tools/* */
  apiToken?: string;
  ttlMs?: number;
  catalogTtlMs?: number;
  timeoutMs?: number;
  logger?: Logger;
  /** Inject for tests. */
  postTrades?: (body: Record<string, unknown>) => Promise<ScTradeRoute[]>;
  postBuyers?: (body: Record<string, unknown>) => Promise<ScTradeTransaction[]>;
  postItinerary?: (body: Record<string, unknown>) => Promise<ScTradeRoute[]>;
  postCircuit?: (
    tradeId: number,
    body: Record<string, unknown>,
  ) => Promise<ScTradeRoute[]>;
  fetchShips?: () => Promise<ScTradeShip[]>;
  fetchLocations?: () => Promise<Array<{ name: string; type?: string }>>;
}

function envEnabled(): boolean {
  const v = (process.env.ECONOMY_SCTRADE ?? process.env.SCTRADE_ENABLED ?? "1").toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function envToken(): string {
  return (
    process.env.SC_TRADE_API_TOKEN ||
    process.env.SCTRADE_API_TOKEN ||
    process.env.ECONOMY_SCTRADE_TOKEN ||
    ""
  ).trim();
}

function clampBox(n: number | undefined, fallback = 32): number {
  const allowed = [1, 2, 4, 8, 16, 24, 32];
  const v = n != null && Number.isFinite(n) ? Math.floor(n) : fallback;
  if (allowed.includes(v)) return v;
  // nearest allowed ≤ v
  let best = 1;
  for (const a of allowed) {
    if (a <= v) best = a;
  }
  return best;
}

/** Pure: build BoundedTradeFormDto body with safe defaults. */
export function buildTradesBody(opts: TradeSearchOpts): Record<string, unknown> {
  const locationNames = opts.locationNames ?? [];
  const commodityNames = opts.commodityInclude ?? [];
  return {
    locationNames,
    locationNamesType: (locationNames.length ? "whitelist" : "blacklist") as ListMode,
    locationTypes: [],
    locationTypesType: "blacklist" as ListMode,
    factionNames: [],
    factionsNamesType: "blacklist" as ListMode,
    commodityNames,
    commodityNamesType: (commodityNames.length ? "whitelist" : "blacklist") as ListMode,
    commodityTypes: [],
    commodityTypesType: "blacklist" as ListMode,
    ship: opts.ship,
    investment: Math.max(1, Math.min(100_000_000, Math.floor(opts.investment))),
    maxStops: Math.max(1, Math.min(5, Math.floor(opts.maxStops ?? 1))),
    maxVolume: 1,
    minInventorySizeInScu: Math.max(0, Math.floor(opts.minInventorySizeInScu ?? 1)),
    minSecurityLevel: Math.max(0, Math.min(99, Math.floor(opts.minSecurityLevel ?? 1))),
    profitType: opts.profitType === "pure" ? "pure" : "time",
    supportedBoxSizeInScu: clampBox(opts.supportedBoxSizeInScu, 32),
    useAutoLoading: opts.useAutoLoading === true,
    allowWaitTimes: opts.allowWaitTimes === true,
    avoidHiddenLocations: opts.avoidHiddenLocations !== false,
    smartFilters: opts.smartFilters === true,
    ...(opts.originShop ? { origin: opts.originShop } : {}),
  };
}

export function buildItineraryBody(opts: ItineraryOpts): Record<string, unknown> {
  return {
    ...buildTradesBody(opts),
    origin: opts.origin,
    destination: opts.destination,
    allowableDetour: Math.max(0, Math.min(100, Math.floor(opts.allowableDetour ?? 25))),
  };
}

export function buildBuyersBody(opts: BuyersOpts): Record<string, unknown> {
  const locationNames = opts.locationInclude ?? [];
  return {
    locationNames,
    locationNamesType: (locationNames.length ? "whitelist" : "blacklist") as ListMode,
    locationTypes: [],
    locationTypesType: "blacklist" as ListMode,
    factionNames: [],
    factionsNamesType: "blacklist" as ListMode,
    commodityName: opts.commodityName,
    commodityQuantityInScu: Math.max(1, Math.floor(opts.commodityQuantityInScu)),
    isCargoStolen: opts.isCargoStolen === true,
    minInventorySizeInScu: Math.max(0, Math.floor(opts.minInventorySizeInScu ?? 1)),
    minSecurityLevel: Math.max(0, Math.min(99, Math.floor(opts.minSecurityLevel ?? 1))),
    supportedBoxSizeInScu: clampBox(opts.supportedBoxSizeInScu, 32),
    allowWaitTimes: opts.allowWaitTimes === true,
    avoidHiddenLocations: opts.avoidHiddenLocations !== false,
  };
}

export function formatMoney(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString();
}

export function formatDuration(sec: number | undefined | null): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h ${rm}m`;
  }
  return `${m}m ${s}s`;
}

export function shortPlace(tx?: ScTradeTransaction): string {
  if (!tx) return "?";
  return (tx.locationAndShop || tx.shop || tx.location || "?").replace(/\s*>\s*/g, " › ");
}

export class ScTradeClient {
  private enabled: boolean;
  private baseUrl: string;
  private apiToken: string;
  private ttlMs: number;
  private catalogTtlMs: number;
  private timeoutMs: number;
  private logger?: Logger;
  private postTrades?: ScTradeClientOptions["postTrades"];
  private postBuyers?: ScTradeClientOptions["postBuyers"];
  private postItinerary?: ScTradeClientOptions["postItinerary"];
  private postCircuit?: ScTradeClientOptions["postCircuit"];
  private fetchShips?: ScTradeClientOptions["fetchShips"];
  private fetchLocations?: ScTradeClientOptions["fetchLocations"];

  private routeCache = new Map<string, { at: number; data: ScTradeRoute[] }>();
  private shipsCache: { at: number; data: ScTradeShip[] } | null = null;
  private locationsCache: { at: number; data: Array<{ name: string; type?: string }> } | null =
    null;

  constructor(opts: ScTradeClientOptions = {}) {
    this.enabled = opts.enabled ?? envEnabled();
    this.baseUrl = (opts.baseUrl ?? process.env.SCTRADE_API_BASE ?? DEFAULT_BASE).replace(
      /\/$/,
      "",
    );
    this.apiToken = (opts.apiToken ?? envToken()).trim();
    this.ttlMs =
      opts.ttlMs ?? (parseInt(process.env.SCTRADE_CACHE_TTL_MS || "", 10) || DEFAULT_TTL_MS);
    this.catalogTtlMs =
      opts.catalogTtlMs ??
      (parseInt(process.env.SCTRADE_CATALOG_TTL_MS || "", 10) || DEFAULT_CATALOG_TTL_MS);
    this.timeoutMs =
      opts.timeoutMs ?? (parseInt(process.env.SCTRADE_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS);
    this.logger = opts.logger;
    this.postTrades = opts.postTrades;
    this.postBuyers = opts.postBuyers;
    this.postItinerary = opts.postItinerary;
    this.postCircuit = opts.postCircuit;
    this.fetchShips = opts.fetchShips;
    this.fetchLocations = opts.fetchLocations;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  hasToken(): boolean {
    return this.apiToken.length > 0;
  }

  clearCache(): void {
    this.routeCache.clear();
    this.shipsCache = null;
    this.locationsCache = null;
  }

  private headers(needToken: boolean): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
    if (needToken && this.apiToken) {
      h.token = this.apiToken;
    }
    return h;
  }

  private tokenMissingError(): Error {
    return new Error(
      "SC Trade API token required for route tools. Set SC_TRADE_API_TOKEN (Patreon API licence). See https://www.patreon.com/cw/sc_trade_tools/membership",
    );
  }

  async getShips(): Promise<ScTradeShip[] | null> {
    if (!this.enabled) return null;
    const now = Date.now();
    if (this.shipsCache && now - this.shipsCache.at < this.catalogTtlMs) {
      return this.shipsCache.data;
    }
    try {
      let data: ScTradeShip[];
      if (this.fetchShips) {
        data = await this.fetchShips();
      } else {
        const res = await axios.get(`${this.baseUrl}/api/ships`, {
          timeout: this.timeoutMs,
          headers: this.headers(false),
        });
        data = Array.isArray(res.data) ? res.data : [];
      }
      this.shipsCache = { at: now, data };
      return data;
    } catch (err) {
      this.logger?.warn({ err }, "sc-trade ships fetch failed");
      return this.shipsCache?.data ?? null;
    }
  }

  async getLocations(): Promise<Array<{ name: string; type?: string }> | null> {
    if (!this.enabled) return null;
    const now = Date.now();
    if (this.locationsCache && now - this.locationsCache.at < this.catalogTtlMs) {
      return this.locationsCache.data;
    }
    try {
      let data: Array<{ name: string; type?: string }>;
      if (this.fetchLocations) {
        data = await this.fetchLocations();
      } else {
        const res = await axios.get(`${this.baseUrl}/api/locations`, {
          timeout: this.timeoutMs,
          headers: this.headers(false),
        });
        data = Array.isArray(res.data) ? res.data : [];
      }
      this.locationsCache = { at: now, data };
      return data;
    } catch (err) {
      this.logger?.warn({ err }, "sc-trade locations fetch failed");
      return this.locationsCache?.data ?? null;
    }
  }

  /** Resolve ship name case-insensitively; prefer exact then includes. */
  async resolveShip(query: string): Promise<ScTradeShip | null> {
    const ships = await this.getShips();
    if (!ships?.length) return null;
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const exact = ships.find((s) => s.name.toLowerCase() === q);
    if (exact) return exact;
    const starts = ships.filter((s) => s.name.toLowerCase().startsWith(q));
    if (starts.length === 1) return starts[0]!;
    const inc = ships.filter((s) => s.name.toLowerCase().includes(q));
    if (inc.length === 1) return inc[0]!;
    // Prefer cargo haulers when ambiguous short query
    if (inc.length > 1) {
      const max = inc.find((s) => /max|hercules|caterpillar|hull/i.test(s.name));
      return max ?? inc[0]!;
    }
    return null;
  }

  /** Expand system/region prefixes into full location names for whitelist. */
  async expandLocationPrefixes(prefixes: string[]): Promise<string[]> {
    if (!prefixes.length) return [];
    const locs = await this.getLocations();
    if (!locs?.length) return prefixes;
    const out = new Set<string>();
    for (const p of prefixes) {
      const pl = p.trim().toLowerCase();
      if (!pl) continue;
      let hit = false;
      for (const loc of locs) {
        const n = loc.name || "";
        if (n.toLowerCase().startsWith(pl) || n.toLowerCase().includes(pl)) {
          out.add(n);
          hit = true;
        }
      }
      if (!hit) out.add(p.trim());
    }
    // Cap whitelist size to avoid huge bodies
    return [...out].slice(0, 200);
  }

  private async withLocationNames(opts: TradeSearchOpts): Promise<TradeSearchOpts> {
    if (opts.locationNames?.length) return opts;
    if (!opts.locationInclude?.length) return opts;
    const names = await this.expandLocationPrefixes(opts.locationInclude);
    return { ...opts, locationNames: names };
  }

  async findTrades(opts: TradeSearchOpts): Promise<
    | { ok: true; routes: ScTradeRoute[]; attribution: string }
    | { ok: false; error: string }
  > {
    if (!this.enabled) return { ok: false, error: "sc-trade disabled (ECONOMY_SCTRADE=0)." };
    if (!this.hasToken() && !this.postTrades) {
      return { ok: false, error: this.tokenMissingError().message };
    }
    try {
      const resolved = await this.withLocationNames(opts);
      const body = buildTradesBody(resolved);
      const cacheKey = `trades:${JSON.stringify(body)}`;
      const now = Date.now();
      const hit = this.routeCache.get(cacheKey);
      if (hit && now - hit.at < this.ttlMs) {
        return { ok: true, routes: hit.data, attribution: SC_TRADE_ATTRIBUTION };
      }
      let routes: ScTradeRoute[];
      if (this.postTrades) {
        routes = await this.postTrades(body);
      } else {
        routes = await this.postJson<ScTradeRoute[]>("/api/tools/trades", body);
      }
      const max = Math.max(1, Math.min(15, opts.maxResults ?? 5));
      const sliced = (Array.isArray(routes) ? routes : []).slice(0, max);
      this.routeCache.set(cacheKey, { at: now, data: sliced });
      return { ok: true, routes: sliced, attribution: SC_TRADE_ATTRIBUTION };
    } catch (err) {
      return { ok: false, error: this.describeError(err) };
    }
  }

  async findItinerary(opts: ItineraryOpts): Promise<
    | { ok: true; routes: ScTradeRoute[]; attribution: string }
    | { ok: false; error: string }
  > {
    if (!this.enabled) return { ok: false, error: "sc-trade disabled (ECONOMY_SCTRADE=0)." };
    if (!this.hasToken() && !this.postItinerary) {
      return { ok: false, error: this.tokenMissingError().message };
    }
    try {
      const resolved = (await this.withLocationNames(opts)) as ItineraryOpts;
      const body = buildItineraryBody({ ...resolved, origin: opts.origin, destination: opts.destination });
      let routes: ScTradeRoute[];
      if (this.postItinerary) {
        routes = await this.postItinerary(body);
      } else {
        routes = await this.postJson<ScTradeRoute[]>("/api/tools/itinerary", body);
      }
      const max = Math.max(1, Math.min(15, opts.maxResults ?? 5));
      return {
        ok: true,
        routes: (Array.isArray(routes) ? routes : []).slice(0, max),
        attribution: SC_TRADE_ATTRIBUTION,
      };
    } catch (err) {
      return { ok: false, error: this.describeError(err) };
    }
  }

  async findCircuit(
    tradeId: number,
    opts: TradeSearchOpts,
  ): Promise<
    | { ok: true; routes: ScTradeRoute[]; attribution: string }
    | { ok: false; error: string }
  > {
    if (!this.enabled) return { ok: false, error: "sc-trade disabled (ECONOMY_SCTRADE=0)." };
    if (!this.hasToken() && !this.postCircuit) {
      return { ok: false, error: this.tokenMissingError().message };
    }
    try {
      const resolved = await this.withLocationNames(opts);
      const body = buildTradesBody(resolved);
      let routes: ScTradeRoute[];
      if (this.postCircuit) {
        routes = await this.postCircuit(tradeId, body);
      } else {
        routes = await this.postJson<ScTradeRoute[]>(
          `/api/tools/circuits/${encodeURIComponent(String(tradeId))}`,
          body,
        );
      }
      const max = Math.max(1, Math.min(15, opts.maxResults ?? 5));
      return {
        ok: true,
        routes: (Array.isArray(routes) ? routes : []).slice(0, max),
        attribution: SC_TRADE_ATTRIBUTION,
      };
    } catch (err) {
      return { ok: false, error: this.describeError(err) };
    }
  }

  async findBuyers(opts: BuyersOpts): Promise<
    | { ok: true; buyers: ScTradeTransaction[]; attribution: string }
    | { ok: false; error: string }
  > {
    if (!this.enabled) return { ok: false, error: "sc-trade disabled (ECONOMY_SCTRADE=0)." };
    if (!this.hasToken() && !this.postBuyers) {
      return { ok: false, error: this.tokenMissingError().message };
    }
    try {
      let locationInclude = opts.locationInclude;
      if (locationInclude?.length) {
        locationInclude = await this.expandLocationPrefixes(locationInclude);
      }
      const body = buildBuyersBody({ ...opts, locationInclude });
      let buyers: ScTradeTransaction[];
      if (this.postBuyers) {
        buyers = await this.postBuyers(body);
      } else {
        buyers = await this.postJson<ScTradeTransaction[]>("/api/tools/buyers", body);
      }
      const max = Math.max(1, Math.min(15, opts.maxResults ?? 8));
      return {
        ok: true,
        buyers: (Array.isArray(buyers) ? buyers : []).slice(0, max),
        attribution: SC_TRADE_ATTRIBUTION,
      };
    } catch (err) {
      return { ok: false, error: this.describeError(err) };
    }
  }

  private async postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
    try {
      const res = await axios.post(`${this.baseUrl}${path}`, body, {
        timeout: this.timeoutMs,
        headers: this.headers(true),
      });
      return res.data as T;
    } catch (err) {
      throw err;
    }
  }

  private describeError(err: unknown): string {
    const ax = err as AxiosError;
    const status = ax.response?.status;
    const data = ax.response?.data;
    let detail = "";
    if (typeof data === "string") detail = data.slice(0, 200);
    else if (data && typeof data === "object") {
      detail = JSON.stringify(data).slice(0, 200);
    } else if (err instanceof Error) {
      detail = err.message;
    }
    if (status === 403) {
      return (
        "sc-trade rejected the API token (403). Check SC_TRADE_API_TOKEN / Patreon licence. " +
        (detail.includes("CAPTCHA") || detail.includes("licence") || detail.includes("license")
          ? detail.slice(0, 160)
          : "")
      );
    }
    if (status === 429) {
      return "sc-trade rate limited (429). Back off and retry later.";
    }
    if (status === 400) {
      return `sc-trade bad request (400): ${detail || "check ship name / parameters"}`;
    }
    this.logger?.warn({ err }, "sc-trade request failed");
    return `sc-trade unavailable${status ? ` (${status})` : ""}: ${detail || "network error"}`;
  }
}

let defaultClient: ScTradeClient | null = null;

export function getScTradeClient(logger?: Logger): ScTradeClient {
  if (!defaultClient) defaultClient = new ScTradeClient({ logger });
  return defaultClient;
}

export function setScTradeClientForTests(client: ScTradeClient | null): void {
  defaultClient = client;
}
