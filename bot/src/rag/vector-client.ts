import type { Logger } from "../logger.js";
import { errorMessage, httpStatus } from "../util/error.js";
import { fetchJson, withQuery } from "../util/http.js";

export interface VectorPoint {
  id: string | number;
  vector: number[];
  payload?: Record<string, unknown>;
}

export interface VectorHit {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

export interface VectorClientOptions {
  baseUrl?: string; // http://turbovec:6333 (TurboVec bridge; Qdrant-shaped subset)
  timeoutMs?: number;
  logger?: Logger;
}

/**
 * TurboVec vector-store REST client (formerly named QdrantClient).
 * Speaks the Qdrant-shaped subset implemented by **turbovec-bridge**
 * (`services/turbovec-bridge`, default `http://turbovec:6333`):
 * ensureCollection / upsert / search / deleteBySource, Cosine distance.
 */
export class VectorClient {
  private baseUrl: string;
  private logger?: Logger;
  private timeoutMs: number;
  private jsonHeaders = { "Content-Type": "application/json" };

  constructor(options: VectorClientOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.VECTOR_DB_URL || "http://turbovec:6333").replace(
      /\/$/,
      "",
    );
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  /** Create the collection if absent; warn (don't auto-destroy) on a dim mismatch. */
  async ensureCollection(name: string, dim: number): Promise<void> {
    try {
      const data = await fetchJson<{
        result?: { config?: { params?: { vectors?: { size?: number } } } };
      }>(this.url(`/collections/${name}`), { timeoutMs: this.timeoutMs });
      const existing = data?.result?.config?.params?.vectors?.size;
      if (existing && existing !== dim) {
        this.logger?.warn(
          { name, existing, dim },
          "Vector store collection dim mismatch — recreate the collection to change embedding model",
        );
      }
      return;
    } catch (err: unknown) {
      if (httpStatus(err) !== 404) {
        this.logger?.debug(
          { err: errorMessage(err) },
          "Vector store collection probe failed; attempting create",
        );
      }
    }
    await fetchJson(this.url(`/collections/${name}`), {
      method: "PUT",
      timeoutMs: this.timeoutMs,
      headers: this.jsonHeaders,
      body: JSON.stringify({ vectors: { size: dim, distance: "Cosine" } }),
    });
    this.logger?.info({ name, dim }, "Created vector store collection");
  }

  async upsert(name: string, points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;
    await fetchJson(withQuery(this.url(`/collections/${name}/points`), { wait: true }), {
      method: "PUT",
      timeoutMs: this.timeoutMs,
      headers: this.jsonHeaders,
      body: JSON.stringify({ points }),
    });
  }

  async search(
    name: string,
    vector: number[],
    topK: number,
    filter?: unknown,
  ): Promise<VectorHit[]> {
    const data = await fetchJson<{ result?: VectorHit[] }>(
      this.url(`/collections/${name}/points/search`),
      {
        method: "POST",
        timeoutMs: this.timeoutMs,
        headers: this.jsonHeaders,
        body: JSON.stringify({
          vector,
          limit: topK,
          with_payload: true,
          ...(filter ? { filter } : {}),
        }),
      },
    );
    return (data?.result ?? []) as VectorHit[];
  }

  /** Purge a source's chunks (re-ingest: drop stale chunks before re-upserting). */
  async deleteBySource(name: string, source: string): Promise<void> {
    await fetchJson(withQuery(this.url(`/collections/${name}/points/delete`), { wait: true }), {
      method: "POST",
      timeoutMs: this.timeoutMs,
      headers: this.jsonHeaders,
      body: JSON.stringify({
        filter: { must: [{ key: "source", match: { value: source } }] },
      }),
    });
  }
}
