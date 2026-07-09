/**
 * Optional SC Craft Tools client — public JSON blueprints for !craft / !econ.
 *
 * Policy (docs/economy.md):
 *  - Public JSON API only (not HTML scrape). Host: sc-craft.tools
 *  - Polite defaults: long cache TTL, short timeout, identifiable User-Agent.
 *  - Fail soft: offline → null, never throw into command path.
 *  - Attribution required in user-facing replies.
 *  - Fan tool (Norkaan / HTTPS org); not CIG.
 */
import axios from "axios";
import type { Logger } from "../logger.js";
import { getEconomyDiskCache, type EconomyDiskCache } from "./cache/store.js";
import type { CraftBomLine, CraftOrder } from "./orders.js";

const DEFAULT_BASE = "https://sc-craft.tools";
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_TIMEOUT_MS = 8_000;
const USER_AGENT =
  "Moneypenny-OrgEconomy/1.0 (+https://github.com; sc-craft.tools client; cache-friendly)";

export const SC_CRAFT_ATTRIBUTION =
  "Blueprints via SC Craft Tools (sc-craft.tools) — cached. Fan data, not CIG.";

export interface ScCraftIngredient {
  slot?: string;
  name?: string;
  quantity_scu?: number;
  options?: Array<{
    name?: string;
    quantity_scu?: number;
    unit?: string;
  }>;
}

export interface ScCraftBlueprint {
  id: number;
  blueprint_id?: string;
  name: string;
  category?: string;
  craft_time_seconds?: number;
  version?: string;
  ingredients?: ScCraftIngredient[];
  missions?: Array<{ name?: string; drop_chance?: string }>;
}

export interface ScCraftSearchResult {
  items: ScCraftBlueprint[];
  total: number;
  version?: string;
  fetchedAt: number;
  attribution: string;
}

export interface ScCraftClientOptions {
  /** Default true unless ECONOMY_SCCRAFT=0 / false / off. */
  enabled?: boolean;
  baseUrl?: string;
  ttlMs?: number;
  timeoutMs?: number;
  logger?: Logger;
  disk?: EconomyDiskCache;
  /** Inject for tests. */
  fetchSearch?: (query: string, limit: number) => Promise<ScCraftBlueprint[]>;
  fetchDetail?: (id: number | string) => Promise<ScCraftBlueprint | null>;
}

function envEnabled(): boolean {
  const v = (process.env.ECONOMY_SCCRAFT ?? process.env.SCCRAFT_ENABLED ?? "1").toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Score how well a blueprint matches a user query (higher = better). */
export function scoreBlueprintMatch(query: string, bp: Pick<ScCraftBlueprint, "name" | "blueprint_id" | "category">): number {
  const q = norm(query);
  if (!q) return 0;
  const name = norm(bp.name || "");
  const id = norm(bp.blueprint_id || "");
  const cat = norm(bp.category || "");
  if (!name && !id) return 0;
  if (name === q || id === q) return 100;
  if (name.startsWith(q) || id.startsWith(q)) return 80;
  if (name.includes(q) || id.includes(q)) return 60;
  // multi-token: all tokens present
  const tokens = q.split(" ").filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => name.includes(t) || id.includes(t))) return 50;
  if (cat.includes(q)) return 20;
  return 0;
}

/** Map sc-craft ingredients → BOM lines (qty multiplier applied). */
export function blueprintToBom(bp: ScCraftBlueprint, qty = 1): CraftBomLine[] {
  const n = Math.max(1, Math.floor(qty));
  const lines: CraftBomLine[] = [];
  for (const ing of bp.ingredients ?? []) {
    const opt = ing.options?.[0];
    const name = (ing.name || opt?.name || ing.slot || "unknown").trim();
    const scu = Number(ing.quantity_scu ?? opt?.quantity_scu ?? 0);
    if (!Number.isFinite(scu) || scu <= 0) continue;
    const amount = Math.round(scu * n * 1000) / 1000;
    const materialId = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    lines.push({
      materialId: materialId || "material",
      label: name,
      amount,
      unit: "scu",
    });
  }
  return lines;
}

/** Build a CraftOrder-shaped object from a sc-craft blueprint. */
export function blueprintToCraftOrder(bp: ScCraftBlueprint, qty = 1): CraftOrder {
  const n = Math.max(1, Math.floor(qty));
  const bom = blueprintToBom(bp, n);
  const craftMin =
    bp.craft_time_seconds != null && bp.craft_time_seconds > 0
      ? Math.round((bp.craft_time_seconds * n) / 60)
      : null;
  return {
    recipe: {
      id: bp.blueprint_id || `sc-craft-${bp.id}`,
      name: bp.name + (craftMin != null ? ` (~${craftMin} min)` : ""),
      aliases: bp.blueprint_id ? [bp.blueprint_id] : [],
      ingredients: bom.map((b) => ({
        materialId: b.materialId,
        amount: b.amount / n,
        unit: b.unit,
      })),
      stationHint: bp.category || "",
      notes: "",
    },
    qty: n,
    bom,
    impliedRawHint: [],
    steps: [],
    disclaimer: SC_CRAFT_ATTRIBUTION,
  };
}

export class ScCraftClient {
  private enabled: boolean;
  private baseUrl: string;
  private ttlMs: number;
  private timeoutMs: number;
  private logger?: Logger;
  private disk: EconomyDiskCache;
  private fetchSearch?: (query: string, limit: number) => Promise<ScCraftBlueprint[]>;
  private fetchDetail?: (id: number | string) => Promise<ScCraftBlueprint | null>;

  /** Cache key → { at, data } for search and detail. */
  private searchCache = new Map<string, { at: number; data: ScCraftBlueprint[]; total: number }>();
  private detailCache = new Map<string, { at: number; data: ScCraftBlueprint }>();
  private inflightSearch = new Map<string, Promise<ScCraftSearchResult>>();

  constructor(opts: ScCraftClientOptions = {}) {
    this.enabled = opts.enabled ?? envEnabled();
    this.baseUrl = (opts.baseUrl ?? process.env.SCCRAFT_API_BASE ?? DEFAULT_BASE).replace(/\/$/, "");
    this.ttlMs =
      opts.ttlMs ?? (parseInt(process.env.SCCRAFT_CACHE_TTL_MS || "", 10) || DEFAULT_TTL_MS);
    this.timeoutMs =
      opts.timeoutMs ?? (parseInt(process.env.SCCRAFT_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS);
    this.logger = opts.logger;
    this.disk = opts.disk ?? getEconomyDiskCache();
    this.fetchSearch = opts.fetchSearch;
    this.fetchDetail = opts.fetchDetail;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  clearCache(): void {
    this.searchCache.clear();
    this.detailCache.clear();
  }

  async search(query: string, limit = 8): Promise<ScCraftSearchResult | null> {
    if (!this.enabled) return null;
    const q = query.trim();
    if (!q) return null;
    const lim = Math.max(1, Math.min(24, limit));
    const key = `${norm(q)}|${lim}`;
    const now = Date.now();
    const hit = this.searchCache.get(key);
    if (hit && now - hit.at < this.ttlMs) {
      return {
        items: hit.data,
        total: hit.total,
        fetchedAt: hit.at,
        attribution: SC_CRAFT_ATTRIBUTION,
      };
    }
    const diskKey = `search:${key}`;
    const diskHit = this.disk.get<ScCraftSearchResult>("sc-craft", diskKey, now);
    if (diskHit && !diskHit.stale) {
      this.searchCache.set(key, {
        at: diskHit.fetchedAt,
        data: diskHit.data.items,
        total: diskHit.data.total,
      });
      return { ...diskHit.data, fetchedAt: diskHit.fetchedAt, attribution: SC_CRAFT_ATTRIBUTION };
    }
    const inflight = this.inflightSearch.get(key);
    if (inflight) {
      try {
        return await inflight;
      } catch {
        return hit
          ? {
              items: hit.data,
              total: hit.total,
              fetchedAt: hit.at,
              attribution: SC_CRAFT_ATTRIBUTION,
            }
          : null;
      }
    }
    const p = this.loadSearch(q, lim)
      .then((res) => {
        const at = Date.now();
        this.searchCache.set(key, { at, data: res.items, total: res.total });
        this.disk.set(
          "sc-craft",
          diskKey,
          { items: res.items, total: res.total, fetchedAt: at, attribution: SC_CRAFT_ATTRIBUTION },
          this.ttlMs,
        );
        return res;
      })
      .finally(() => {
        this.inflightSearch.delete(key);
      });
    this.inflightSearch.set(key, p);
    try {
      return await p;
    } catch (err) {
      this.logger?.warn({ err, query: q }, "sc-craft search failed");
      if (hit) {
        return {
          items: hit.data,
          total: hit.total,
          fetchedAt: hit.at,
          attribution: SC_CRAFT_ATTRIBUTION,
        };
      }
      if (diskHit) {
        return {
          ...diskHit.data,
          fetchedAt: diskHit.fetchedAt,
          attribution: SC_CRAFT_ATTRIBUTION,
        };
      }
      return null;
    }
  }

  private async loadSearch(query: string, limit: number): Promise<ScCraftSearchResult> {
    if (this.fetchSearch) {
      const items = await this.fetchSearch(query, limit);
      return {
        items,
        total: items.length,
        fetchedAt: Date.now(),
        attribution: SC_CRAFT_ATTRIBUTION,
      };
    }
    const url = `${this.baseUrl}/api/blueprints`;
    const { data } = await axios.get(url, {
      timeout: this.timeoutMs,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      params: { search: query, limit, page: 1 },
    });
    const items = Array.isArray(data?.items) ? (data.items as ScCraftBlueprint[]) : [];
    const total = Number(data?.pagination?.total ?? items.length) || items.length;
    // Prefer stronger name matches first.
    const ranked = [...items].sort(
      (a, b) => scoreBlueprintMatch(query, b) - scoreBlueprintMatch(query, a),
    );
    this.logger?.debug({ query, count: ranked.length, total }, "sc-craft search cached");
    return {
      items: ranked,
      total,
      version: ranked[0]?.version,
      fetchedAt: Date.now(),
      attribution: SC_CRAFT_ATTRIBUTION,
    };
  }

  async getById(id: number | string): Promise<ScCraftBlueprint | null> {
    if (!this.enabled) return null;
    const key = String(id);
    const now = Date.now();
    const hit = this.detailCache.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.data;
    try {
      let data: ScCraftBlueprint | null;
      if (this.fetchDetail) {
        data = await this.fetchDetail(id);
      } else {
        const url = `${this.baseUrl}/api/blueprints/${encodeURIComponent(key)}`;
        const res = await axios.get(url, {
          timeout: this.timeoutMs,
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        });
        data = res.data as ScCraftBlueprint;
      }
      if (!data || typeof data !== "object" || !data.name) return null;
      this.detailCache.set(key, { at: Date.now(), data });
      return data;
    } catch (err) {
      this.logger?.warn({ err, id }, "sc-craft detail failed");
      return hit?.data ?? null;
    }
  }

  /**
   * Resolve best blueprint for a craft query.
   * Returns null when disabled, offline, or no decent match.
   */
  async resolveBlueprint(query: string): Promise<ScCraftBlueprint | null> {
    const res = await this.search(query, 12);
    if (!res || res.items.length === 0) return null;
    const scored = res.items
      .map((bp) => ({ bp, score: scoreBlueprintMatch(query, bp) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = scored[0]?.bp ?? res.items[0];
    if (!best) return null;
    // Prefer detail payload (full ingredients) when list is partial.
    if (best.id != null && (!best.ingredients || best.ingredients.length === 0)) {
      const full = await this.getById(best.id);
      if (full) return full;
    }
    return best;
  }
}

let defaultClient: ScCraftClient | null = null;

export function getScCraftClient(logger?: Logger): ScCraftClient {
  if (!defaultClient) defaultClient = new ScCraftClient({ logger });
  return defaultClient;
}

/** Test helper. */
export function setScCraftClientForTests(client: ScCraftClient | null): void {
  defaultClient = client;
}
