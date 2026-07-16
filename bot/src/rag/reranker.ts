import axios from "axios";
import type { Logger } from "../logger.js";
import { errorMessage } from "../util/error.js";

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
  private http: ReturnType<typeof axios.create> | null;

  constructor(options: RerankerClientOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.RERANKER_URL || "").replace(/\/$/, "");
    this.model = options.model || process.env.RERANKER_MODEL || "bge-reranker-large";
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.logger = options.logger;
    this.http = this.baseUrl
      ? axios.create({
          baseURL: this.baseUrl,
          timeout: this.timeoutMs,
          headers: { "Content-Type": "application/json" },
        })
      : null;
  }

  get enabled(): boolean {
    return !!this.http;
  }

  getModel(): string {
    return this.model;
  }

  /**
   * Score query against documents. Returns scores aligned to document indices,
   * or null if disabled / failed.
   */
  async rerank(query: string, documents: string[]): Promise<RerankHit[] | null> {
    if (!this.http || !query.trim() || documents.length === 0) return null;
    try {
      // Text Embeddings Inference + some Ollama proxies
      const { data } = await this.http.post("/rerank", {
        model: this.model,
        query,
        documents,
        top_n: documents.length,
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
        const { data } = await this.http.post("/v1/rerank", {
          model: this.model,
          query,
          documents,
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
