/**
 * Star Citizen Wiki API client — enrichment + doctrine grounding.
 *
 * Base: https://api.star-citizen.wiki  (JSON under /api/…)
 * Policy: public JSON, credit api.star-citizen.wiki, long disk cache, fail-open.
 * Ask path reads **disk cache only** (no network).
 *
 * Docs: https://api.star-citizen.wiki/developers · OpenAPI /api/openapi
 */
import axios from "axios";
import type { Logger } from "../logger.js";
import { type EconomyDiskCache, getEconomyDiskCache } from "./cache/store.js";

const DEFAULT_BASE = "https://api.star-citizen.wiki";
/** Game data is patch-stable (major patches ~monthly). */
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const DEFAULT_TIMEOUT_MS = 12_000;
const USER_AGENT =
  "Moneypenny-OrgEconomy/1.0 (+https://github.com; api.star-citizen.wiki client; cache-friendly)";

export const SC_WIKI_ATTRIBUTION =
  "Game data via Star Citizen Wiki API (api.star-citizen.wiki) — cached. Fan site, not CIG.";

export interface ScWikiSearchHit {
  name: string;
  type?: string;
  slug?: string;
  class_name?: string;
  api_url?: string;
  web_url?: string;
  classification_label?: string;
  extra_label?: string | null;
}

export interface ScWikiClientOptions {
  enabled?: boolean;
  baseUrl?: string;
  ttlMs?: number;
  timeoutMs?: number;
  logger?: Logger;
  disk?: EconomyDiskCache;
  fetchSearch?: (query: string) => Promise<ScWikiSearchHit[]>;
  fetchJson?: (path: string) => Promise<unknown>;
}

function envEnabled(): boolean {
  const v = (process.env.ECONOMY_SCWIKI ?? process.env.SCWIKI_ENABLED ?? "1").toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

function slugFromApiUrl(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/\/api\/(?:items|vehicles|commodities|blueprints|locations)\/([^/?#]+)/i);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function typeFromApiUrl(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/\/api\/(items|vehicles|commodities|blueprints|locations)\//i);
  return m?.[1]?.toLowerCase() ?? null;
}

export class ScWikiClient {
  private enabled: boolean;
  private baseUrl: string;
  private ttlMs: number;
  private timeoutMs: number;
  private logger?: Logger;
  private disk: EconomyDiskCache;
  private fetchSearch?: ScWikiClientOptions["fetchSearch"];
  private fetchJson?: ScWikiClientOptions["fetchJson"];

  constructor(opts: ScWikiClientOptions = {}) {
    this.enabled = opts.enabled ?? envEnabled();
    this.baseUrl = (opts.baseUrl ?? process.env.SCWIKI_API_BASE ?? DEFAULT_BASE).replace(/\/$/, "");
    this.ttlMs =
      opts.ttlMs ?? (parseInt(process.env.SCWIKI_CACHE_TTL_MS || "", 10) || DEFAULT_TTL_MS);
    this.timeoutMs =
      opts.timeoutMs ?? (parseInt(process.env.SCWIKI_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS);
    this.logger = opts.logger;
    this.disk = opts.disk ?? getEconomyDiskCache();
    this.fetchSearch = opts.fetchSearch;
    this.fetchJson = opts.fetchJson;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Network search with disk cache (stale-while-revalidate). */
  async search(query: string): Promise<ScWikiSearchHit[] | null> {
    if (!this.enabled) return null;
    const q = query.trim();
    if (!q) return null;
    const cacheKey = `search:${q.toLowerCase()}`;
    const cached = this.disk.get<ScWikiSearchHit[]>("sc-wiki", cacheKey);
    if (cached && !cached.stale) return cached.data;

    try {
      let hits: ScWikiSearchHit[];
      if (this.fetchSearch) {
        hits = await this.fetchSearch(q);
      } else {
        const { data } = await axios.get(`${this.baseUrl}/api/search`, {
          timeout: this.timeoutMs,
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
          params: { "filter[query]": q },
        });
        hits = normalizeSearchPayload(data);
      }
      this.disk.set("sc-wiki", cacheKey, hits, this.ttlMs);
      return hits;
    } catch (err) {
      this.logger?.warn({ err, query: q }, "sc-wiki search failed");
      return cached?.data ?? null;
    }
  }

  async getResource(
    kind: "items" | "vehicles" | "commodities" | "blueprints" | "locations",
    slug: string,
  ): Promise<Record<string, unknown> | null> {
    if (!this.enabled) return null;
    const s = slug.trim();
    if (!s) return null;
    const cacheKey = `${kind}:${s.toLowerCase()}`;
    const cached = this.disk.get<Record<string, unknown>>("sc-wiki", cacheKey);
    if (cached && !cached.stale) return cached.data;

    try {
      let payload: Record<string, unknown>;
      if (this.fetchJson) {
        payload = (await this.fetchJson(`/api/${kind}/${encodeURIComponent(s)}`)) as Record<
          string,
          unknown
        >;
      } else {
        const { data } = await axios.get(`${this.baseUrl}/api/${kind}/${encodeURIComponent(s)}`, {
          timeout: this.timeoutMs,
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        });
        payload = (data?.data ?? data) as Record<string, unknown>;
      }
      if (!payload || typeof payload !== "object") return cached?.data ?? null;
      this.disk.set("sc-wiki", cacheKey, payload, this.ttlMs);
      return payload;
    } catch (err) {
      this.logger?.warn({ err, kind, slug: s }, "sc-wiki resource failed");
      return cached?.data ?? null;
    }
  }

  async getGameVersion(): Promise<string | null> {
    if (!this.enabled) return null;
    const cached = this.disk.get<{ code?: string }>("sc-wiki", "game-version");
    if (cached && !cached.stale) return cached.data.code ?? null;
    try {
      let code: string | null = null;
      if (this.fetchJson) {
        const data = (await this.fetchJson("/api/game-versions/default")) as {
          data?: { code?: string };
        };
        code = data?.data?.code ?? null;
      } else {
        const { data } = await axios.get(`${this.baseUrl}/api/game-versions/default`, {
          timeout: this.timeoutMs,
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        });
        code = data?.data?.code ?? null;
      }
      if (code) this.disk.set("sc-wiki", "game-version", { code }, this.ttlMs);
      return code;
    } catch {
      return cached?.data?.code ?? null;
    }
  }

  /**
   * Best-effort enrichment for a name: search + first solid resource detail.
   * Writes through disk cache for later offline doctrine grounding.
   */
  async enrich(name: string): Promise<string | null> {
    const hits = await this.search(name);
    if (!hits?.length) return null;
    const hit =
      hits.find((h) => h.name?.toLowerCase() === name.toLowerCase()) ??
      hits.find((h) => !/water bottle|drink|poster/i.test(h.name || "")) ??
      hits[0]!;
    const kind = (typeFromApiUrl(hit.api_url) || hit.type || "items") as
      | "items"
      | "vehicles"
      | "commodities"
      | "blueprints"
      | "locations";
    const slug = slugFromApiUrl(hit.api_url) || hit.slug || name.toLowerCase().replace(/\s+/g, "-");
    const detail = await this.getResource(kind, slug);
    return formatWikiSnippet(hit, detail);
  }

  /** Sync: read enrichment text from disk only (for !ask path). */
  readCachedEnrichment(name: string): string | null {
    const q = name.trim().toLowerCase();
    if (!q) return null;
    const searchHit = this.disk.get<ScWikiSearchHit[]>("sc-wiki", `search:${q}`);
    if (!searchHit?.data?.length) return null;
    const hit =
      searchHit.data.find((h) => h.name?.toLowerCase() === q) ??
      searchHit.data.find((h) => !/water bottle|drink|poster/i.test(h.name || "")) ??
      searchHit.data[0]!;
    const kind = (typeFromApiUrl(hit.api_url) || hit.type || "items") as
      | "items"
      | "vehicles"
      | "commodities"
      | "blueprints"
      | "locations";
    const slug = slugFromApiUrl(hit.api_url) || hit.slug;
    if (!slug) {
      return formatWikiSnippet(hit, null);
    }
    const detail = this.disk.get<Record<string, unknown>>(
      "sc-wiki",
      `${kind}:${slug.toLowerCase()}`,
    );
    return formatWikiSnippet(hit, detail?.data ?? null);
  }
}

function normalizeSearchPayload(data: unknown): ScWikiSearchHit[] {
  const root = data as {
    data?: Array<{
      type?: string;
      label?: string;
      results?: Array<Record<string, unknown>>;
    }>;
  };
  const out: ScWikiSearchHit[] = [];
  const groups = Array.isArray(root?.data) ? root.data : [];
  for (const g of groups) {
    const type = g.type;
    for (const r of g.results ?? []) {
      out.push({
        name: String(r.name ?? ""),
        type,
        slug: typeof r.slug === "string" ? r.slug : undefined,
        class_name: typeof r.class_name === "string" ? r.class_name : undefined,
        api_url: typeof r.api_url === "string" ? r.api_url : undefined,
        web_url: typeof r.web_url === "string" ? r.web_url : undefined,
        classification_label:
          typeof r.classification_label === "string" ? r.classification_label : undefined,
        extra_label: (r.extra_label as string | null) ?? null,
      });
    }
  }
  return out.filter((h) => h.name);
}

export function formatWikiSnippet(
  hit: ScWikiSearchHit,
  detail: Record<string, unknown> | null,
): string {
  const lines = [`SC Wiki: ${hit.name}${hit.type ? ` (${hit.type})` : ""}`];
  if (hit.classification_label) lines.push(`Class: ${hit.classification_label}`);
  if (detail) {
    const desc = (detail.description as { en_EN?: string } | string | null | undefined) ?? null;
    let d = "";
    if (typeof desc === "string") d = desc;
    else if (desc && typeof desc === "object" && desc.en_EN) d = desc.en_EN;
    if (d) lines.push(d.replace(/\s+/g, " ").trim().slice(0, 400));
    if (typeof detail.cargo_capacity === "number") {
      lines.push(`Cargo: ${detail.cargo_capacity} SCU`);
    }
    if (typeof detail.craft_time_seconds === "number") {
      lines.push(`Craft time: ~${Math.round(detail.craft_time_seconds / 60)} min`);
    }
    if (typeof detail.output_name === "string") {
      lines.push(`Blueprint output: ${detail.output_name}`);
    }
    const ingredients = detail.ingredients as
      | Array<{ name?: string; quantity_scu?: number }>
      | undefined;
    if (Array.isArray(ingredients) && ingredients.length) {
      const bom = ingredients
        .slice(0, 8)
        .map((i) => `${i.name ?? "?"}${i.quantity_scu != null ? ` ${i.quantity_scu} SCU` : ""}`)
        .join("; ");
      lines.push(`Ingredients: ${bom}`);
    }
  }
  lines.push(SC_WIKI_ATTRIBUTION);
  return lines.join("\n");
}

let defaultClient: ScWikiClient | null = null;

export function getScWikiClient(logger?: Logger): ScWikiClient {
  if (!defaultClient) defaultClient = new ScWikiClient({ logger });
  return defaultClient;
}

export function setScWikiClientForTests(client: ScWikiClient | null): void {
  defaultClient = client;
}
