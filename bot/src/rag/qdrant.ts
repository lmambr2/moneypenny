import axios from "axios";
import type { Logger } from "../logger.js";

export interface QdrantPoint {
  id: string | number;
  vector: number[];
  payload?: Record<string, unknown>;
}

export interface QdrantHit {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

export interface QdrantClientOptions {
  baseUrl?: string; // http://qdrant:6333
  timeoutMs?: number;
  logger?: Logger;
}

/**
 * Minimal Qdrant REST client (axios) for the Phase 5 substrate — only
 * ensureCollection / upsert / search / deleteBySource, Cosine distance. Uses the
 * same axios the rest of the app uses (no extra qdrant client dependency), and
 * works against any Qdrant whether on the Pi or the x86 box (config-driven URL).
 */
export class QdrantClient {
  private baseUrl: string;
  private logger?: Logger;
  private http: ReturnType<typeof axios.create>;

  constructor(options: QdrantClientOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.VECTOR_DB_URL || "http://qdrant:6333").replace(/\/$/, "");
    this.logger = options.logger;
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: options.timeoutMs ?? 30000,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** Create the collection if absent; warn (don't auto-destroy) on a dim mismatch. */
  async ensureCollection(name: string, dim: number): Promise<void> {
    try {
      const { data } = await this.http.get(`/collections/${name}`);
      const existing = data?.result?.config?.params?.vectors?.size;
      if (existing && existing !== dim) {
        this.logger?.warn(
          { name, existing, dim },
          "Qdrant collection dim mismatch — recreate the collection to change embedding model",
        );
      }
      return;
    } catch (err: any) {
      if (err?.response?.status !== 404) {
        this.logger?.debug({ err: err?.message }, "Qdrant collection probe failed; attempting create");
      }
    }
    await this.http.put(`/collections/${name}`, { vectors: { size: dim, distance: "Cosine" } });
    this.logger?.info({ name, dim }, "Created Qdrant collection");
  }

  async upsert(name: string, points: QdrantPoint[]): Promise<void> {
    if (points.length === 0) return;
    await this.http.put(`/collections/${name}/points?wait=true`, { points });
  }

  async search(name: string, vector: number[], topK: number, filter?: unknown): Promise<QdrantHit[]> {
    const { data } = await this.http.post(`/collections/${name}/points/search`, {
      vector,
      limit: topK,
      with_payload: true,
      ...(filter ? { filter } : {}),
    });
    return (data?.result ?? []) as QdrantHit[];
  }

  /** Purge a source's chunks (re-ingest: drop stale chunks before re-upserting). */
  async deleteBySource(name: string, source: string): Promise<void> {
    await this.http.post(`/collections/${name}/points/delete?wait=true`, {
      filter: { must: [{ key: "source", match: { value: source } }] },
    });
  }
}
