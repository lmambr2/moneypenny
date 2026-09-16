import { fetchWithTimeout } from "../util/http.js";
import { isOllamaBaseUrl, normalizeLlmBaseUrl } from "./client.js";

export type LlmCatalogModel = {
  id: string;
  ownedBy?: string;
  maxModelLen?: number;
  root?: string;
};

export type LlmCatalog = {
  url: string;
  available: boolean;
  error?: string;
  models: LlmCatalogModel[];
};

/** Accept http(s) origins only. Strips a trailing /v1. Rejects credentials. */
export function parseLlmOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const u = new URL(normalizeLlmBaseUrl(trimmed));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return normalizeLlmBaseUrl(u.toString());
  } catch {
    return null;
  }
}

function uniqModels(models: LlmCatalogModel[]): LlmCatalogModel[] {
  const seen = new Set<string>();
  const out: LlmCatalogModel[] = [];
  for (const m of models) {
    const id = m.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...m, id });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function fromOpenAi(json: unknown): LlmCatalogModel[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const models: LlmCatalogModel[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id.trim()) continue;
    const max =
      typeof r.max_model_len === "number" && Number.isFinite(r.max_model_len)
        ? r.max_model_len
        : undefined;
    models.push({
      id: r.id,
      ownedBy: typeof r.owned_by === "string" ? r.owned_by : undefined,
      maxModelLen: max,
      root: typeof r.root === "string" ? r.root : undefined,
    });
  }
  return models;
}

function fromOllamaTags(json: unknown): LlmCatalogModel[] {
  if (!json || typeof json !== "object") return [];
  const rows = (json as { models?: unknown }).models;
  if (!Array.isArray(rows)) return [];
  const models: LlmCatalogModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.name === "string" ? r.name : typeof r.model === "string" ? r.model : "";
    if (!id.trim()) continue;
    models.push({ id, ownedBy: "ollama" });
  }
  return models;
}

async function getJson(url: string, timeoutMs: number): Promise<unknown | null> {
  const res = await fetchWithTimeout(url, { timeoutMs });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** List chat models from an OpenAI-compatible (or Ollama) origin. */
export async function fetchLlmCatalog(baseUrl: string, timeoutMs = 2500): Promise<LlmCatalog> {
  const url = parseLlmOrigin(baseUrl);
  if (!url) {
    return { url: baseUrl.trim(), available: false, error: "invalid url", models: [] };
  }
  try {
    const openai = await getJson(`${url}/v1/models`, timeoutMs);
    let models = uniqModels(fromOpenAi(openai));
    if (models.length === 0 && isOllamaBaseUrl(url)) {
      const tags = await getJson(`${url}/api/tags`, timeoutMs);
      models = uniqModels(fromOllamaTags(tags));
    }
    if (!openai && models.length === 0) {
      return { url, available: false, error: "unreachable", models: [] };
    }
    return { url, available: true, models };
  } catch {
    return { url, available: false, error: "unreachable", models: [] };
  }
}
