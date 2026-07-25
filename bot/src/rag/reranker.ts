import type { Logger } from "../logger.js";
import { errorMessage } from "../util/error.js";
import { fetchJson } from "../util/http.js";

export interface RerankerClientOptions {
  /** OpenAI-compat or TEI-style base (POST /v1/rerank or /rerank). Empty = disabled. */
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  logger?: Logger;
}

export interface RerankHit {
  index: number;
  score: number;
}

/**
 * Optional cross-encoder rerank (e.g. bge-reranker-large via TEI / compatible proxy).
 * Fail-open: on error returns null so callers keep ANN order.
 */
export class RerankerClient {
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private logger?: Logger;

  constructor(options: RerankerClientOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.RERANKER_URL || "").replace(/\/$/, "");
    this.model = options.model || process.env.RERANKER_MODEL || "bge-reranker-large";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.logger = options.logger;
  }

  get enabled(): boolean {
    return !!this.baseUrl;
  }

  getModel(): string {
    return this.model;
  }

  /**
   * Score query against documents. Returns scores aligned to document indices,
   * or null if disabled / failed.
   */
  async rerank(query: string, documents: string[]): Promise<RerankHit[] | null> {
    if (!this.baseUrl || !query.trim() || documents.length === 0) return null;
    const headers = { "Content-Type": "application/json" };
    const bodyBase = { model: this.model, query, documents };
    try {
      // Text Embeddings Inference + some Ollama proxies
      const data = await fetchJson<{
        results?: Array<{ index?: number; relevance_score?: number; score?: number }>;
        data?: Array<{ index?: number; relevance_score?: number; score?: number }>;
      }>(`${this.baseUrl}/rerank`, {
        method: "POST",
        timeoutMs: this.timeoutMs,
        headers,
        body: JSON.stringify({ ...bodyBase, top_n: documents.length }),
      });
      const results = (data?.results ?? data?.data ?? []) as Array<{
        index?: number;
        relevance_score?: number;
        score?: number;
      }>;
      if (!Array.isArray(results) || results.length === 0) return null;
      return results
        .map((r, i) => ({
          index: typeof r.index === "number" ? r.index : i,
          score: Number(r.relevance_score ?? r.score ?? 0),
        }))
        .sort((a, b) => b.score - a.score);
    } catch (err: unknown) {
      // Alternate path: OpenAI-style
      try {
        const data = await fetchJson<{
          results?: Array<{ index?: number; relevance_score?: number; score?: number }>;
        }>(`${this.baseUrl}/v1/rerank`, {
          method: "POST",
          timeoutMs: this.timeoutMs,
          headers,
          body: JSON.stringify(bodyBase),
        });
        const results = (data?.results ?? []) as Array<{
          index?: number;
          relevance_score?: number;
          score?: number;
        }>;
        if (!results.length) return null;
        return results
          .map((r, i) => ({
            index: typeof r.index === "number" ? r.index : i,
            score: Number(r.relevance_score ?? r.score ?? 0),
          }))
          .sort((a, b) => b.score - a.score);
      } catch (err2: unknown) {
        this.logger?.warn(
          { err: errorMessage(err2 || err), model: this.model },
          "Reranker failed — using ANN order",
        );
        return null;
      }
    }
  }
}
