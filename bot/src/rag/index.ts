import type { Logger } from "../logger.js";
import { chunkMarkdown } from "./chunk.js";
import type { EmbeddingsClient } from "./embeddings.js";
import type { RerankerClient } from "./reranker.js";
import { isDoctrineExpired } from "./validity.js";
import type { VectorClient, VectorPoint } from "./vector-client.js";

export {
  chunkId,
  chunkMarkdown,
  chunkText,
  DEFAULT_CHUNK_MAX_CHARS,
  DEFAULT_CHUNK_OVERLAP,
} from "./chunk.js";
export { DEFAULT_EMBEDDING_MODEL, defaultModelForEdition, EmbeddingsClient } from "./embeddings.js";
export { l2Normalize, l2NormalizeBatch } from "./normalize.js";
export { RerankerClient } from "./reranker.js";
export { VectorClient } from "./vector-client.js";

export interface RetrievedChunk {
  text: string;
  source: string;
  score: number;
  classification: string;
}

export interface RetrievalStoreOptions {
  embeddings: EmbeddingsClient;
  vectorStore: VectorClient;
  collection: string;
  topK?: number;
  /** Optional cross-encoder; when set, over-fetch ANN then reorder. */
  reranker?: RerankerClient;
  logger?: Logger;
}

/** Pi ollama chokes on huge multi-text embed batches (100+ chunks → timeout). */
const EMBED_BATCH_SIZE = 8;

/**
 * Phase 5 retrieval substrate: `ingest` (chunk → embed → upsert) and `query`
 * (embed query → vector search → optional rerank → chunks).
 */
export class RetrievalStore {
  private embeddings: EmbeddingsClient;
  private vectorStore: VectorClient;
  private collection: string;
  private topK: number;
  private reranker?: RerankerClient;
  private logger?: Logger;
  private ready = false;

  constructor(opts: RetrievalStoreOptions) {
    this.embeddings = opts.embeddings;
    this.vectorStore = opts.vectorStore;
    this.collection = opts.collection;
    this.topK = opts.topK ?? 6;
    this.reranker = opts.reranker;
    this.logger = opts.logger;
  }

  /** Probe the embedding dimension and ensure the collection exists. Idempotent. */
  async init(): Promise<void> {
    if (this.ready) return;
    const dim = await this.embeddings.dimension();
    await this.vectorStore.ensureCollection(this.collection, dim);
    this.ready = true;
    this.logger?.info(
      {
        collection: this.collection,
        dim,
        model: this.embeddings.getModel(),
        reranker: this.reranker?.enabled ? this.reranker.getModel() : null,
      },
      "RetrievalStore ready",
    );
  }

  /** Chunk a document, embed (L2-normalized), and upsert. Replaces prior chunks of the same source. */
  async ingest(
    source: string,
    text: string,
    metadata: Record<string, unknown> = {},
  ): Promise<number> {
    await this.init();
    const chunks = chunkMarkdown(source, text);
    if (chunks.length === 0) return 0;

    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const batchVecs = await this.embeddings.embed(batch.map((c) => c.text));
      vectors.push(...batchVecs);
    }

    const points: VectorPoint[] = chunks.map((c, i) => ({
      id: c.id,
      vector: vectors[i],
      payload: {
        text: c.text,
        source: c.source,
        index: c.index,
        classification: "unclassified",
        ...metadata,
      },
    }));
    await this.vectorStore.deleteBySource(this.collection, source);
    await this.vectorStore.upsert(this.collection, points);
    this.logger?.info({ source, chunks: points.length }, "Ingested document");
    return points.length;
  }

  /** Remove all chunks of a source from the vector store (doctrine delete). */
  async purge(source: string): Promise<void> {
    await this.init();
    await this.vectorStore.deleteBySource(this.collection, source);
  }

  /**
   * Embed the query and return the top-k most similar chunks. When
   * `allowedClassifications` is given (Phase 6 rank-gating), only chunks whose
   * `classification` is in that set are returned. Never throws into callers.
   */
  async query(
    text: string,
    topK?: number,
    allowedClassifications?: string[],
  ): Promise<RetrievedChunk[]> {
    if (!text?.trim()) return [];
    try {
      return await this.queryStrict(text, topK, allowedClassifications);
    } catch (err) {
      this.logger?.warn({ err }, "RAG query failed — answering without retrieved context");
      return [];
    }
  }

  /**
   * Admin/test path — same as {@link query} but surfaces embedding/vector DB
   * failures instead of swallowing them into an empty result.
   */
  async queryStrict(
    text: string,
    topK?: number,
    allowedClassifications?: string[],
  ): Promise<RetrievedChunk[]> {
    if (!text?.trim()) return [];
    await this.init();
    const [vec] = await this.embeddings.embed(text);
    if (!vec) throw new Error("Embedding service returned no vector");
    const filter =
      allowedClassifications && allowedClassifications.length > 0
        ? { must: [{ key: "classification", match: { any: allowedClassifications } }] }
        : undefined;
    const limit = topK ?? this.topK;
    // Over-fetch for optional rerank / post-filter
    const fetchK = this.reranker?.enabled ? Math.max(limit * 8, 20) : Math.max(limit * 4, limit);
    const hits = await this.vectorStore.search(this.collection, vec, fetchK, filter);
    let chunks: RetrievedChunk[] = hits
      .filter((h) => !isDoctrineExpired(payloadField(h.payload, "valid_until") || undefined))
      .map((h) => ({
        text: payloadField(h.payload, "text"),
        source: payloadField(h.payload, "source"),
        score: h.score,
        classification: payloadField(h.payload, "classification", "unclassified"),
      }));

    if (this.reranker?.enabled && chunks.length > 1) {
      const ranked = await this.reranker.rerank(
        text,
        chunks.map((c) => c.text),
      );
      if (ranked?.length) {
        chunks = ranked
          .map((r) => {
            const c = chunks[r.index];
            if (!c) return null;
            return { ...c, score: r.score };
          })
          .filter((c): c is RetrievedChunk => c != null);
      }
    }

    return chunks.slice(0, limit);
  }
}

function payloadField(
  payload: Record<string, unknown> | undefined,
  key: string,
  fallback = "",
): string {
  const value = payload?.[key];
  return value == null ? fallback : String(value);
}
