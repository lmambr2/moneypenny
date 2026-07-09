import type { Logger } from "../logger.js";
import { chunkMarkdown } from "./chunk.js";
import type { EmbeddingsClient } from "./embeddings.js";
import type { QdrantClient, QdrantPoint } from "./qdrant.js";
import { isDoctrineExpired } from "./validity.js";

export { EmbeddingsClient } from "./embeddings.js";
export { QdrantClient } from "./qdrant.js";

export interface RetrievedChunk {
  text: string;
  source: string;
  score: number;
  classification: string;
}

export interface RetrievalStoreOptions {
  embeddings: EmbeddingsClient;
  qdrant: QdrantClient;
  collection: string;
  topK?: number;
  logger?: Logger;
}

/** Pi ollama chokes on huge multi-text embed batches (100+ chunks → timeout). */
const EMBED_BATCH_SIZE = 8;

/**
 * Phase 5 retrieval substrate: `ingest` (chunk → embed → upsert) and `query`
 * (embed query → vector search → chunks). The shared foundation for Phase 6
 * (doc-RAG with citations + rights-gating) and Phase 7 (MemPalace). Endpoints +
 * model are injected, so one store serves both the RK3588 and x86+GPU tracks by
 * config alone. Lazy-inits (probes embedding dim, ensures the collection).
 */
export class RetrievalStore {
  private embeddings: EmbeddingsClient;
  private qdrant: QdrantClient;
  private collection: string;
  private topK: number;
  private logger?: Logger;
  private ready = false;

  constructor(opts: RetrievalStoreOptions) {
    this.embeddings = opts.embeddings;
    this.qdrant = opts.qdrant;
    this.collection = opts.collection;
    this.topK = opts.topK ?? 4;
    this.logger = opts.logger;
  }

  /** Probe the embedding dimension and ensure the collection exists. Idempotent. */
  async init(): Promise<void> {
    if (this.ready) return;
    const dim = await this.embeddings.dimension();
    await this.qdrant.ensureCollection(this.collection, dim);
    this.ready = true;
    this.logger?.info(
      { collection: this.collection, dim, model: this.embeddings.getModel() },
      "RetrievalStore ready",
    );
  }

  /** Chunk a document, embed, and upsert. Replaces any prior chunks of the same source. */
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

    const points: QdrantPoint[] = chunks.map((c, i) => ({
      id: c.id,
      vector: vectors[i],
      // Default classification "unclassified" so the rights-gating filter (Phase
      // 6) matches uniformly; any caller-supplied classification overrides it.
      payload: {
        text: c.text,
        source: c.source,
        index: c.index,
        classification: "unclassified",
        ...metadata,
      },
    }));
    await this.qdrant.deleteBySource(this.collection, source);
    await this.qdrant.upsert(this.collection, points);
    this.logger?.info({ source, chunks: points.length }, "Ingested document");
    return points.length;
  }

  /** Remove all chunks of a source from the vector store (doctrine delete). */
  async purge(source: string): Promise<void> {
    await this.init();
    await this.qdrant.deleteBySource(this.collection, source);
  }

  /**
   * Embed the query and return the top-k most similar chunks. When
   * `allowedClassifications` is given (Phase 6 rank-gating), only chunks whose
   * `classification` is in that set are returned — so unauthorized members never
   * retrieve classified doctrine. Never throws into callers.
   */
  async query(
    text: string,
    topK?: number,
    allowedClassifications?: string[],
  ): Promise<RetrievedChunk[]> {
    if (!text?.trim()) return [];
    try {
      await this.init();
      const [vec] = await this.embeddings.embed(text);
      if (!vec) return [];
      const filter =
        allowedClassifications && allowedClassifications.length > 0
          ? { must: [{ key: "classification", match: { any: allowedClassifications } }] }
          : undefined;
      const limit = topK ?? this.topK;
      const hits = await this.qdrant.search(
        this.collection,
        vec,
        Math.max(limit * 4, limit),
        filter,
      );
      return hits
        .filter((h) => !isDoctrineExpired(payloadField(h.payload, "valid_until") || undefined))
        .slice(0, limit)
        .map((h) => ({
          text: payloadField(h.payload, "text"),
          source: payloadField(h.payload, "source"),
          score: h.score,
          classification: payloadField(h.payload, "classification", "unclassified"),
        }));
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
    const hits = await this.qdrant.search(this.collection, vec, Math.max(limit * 4, limit), filter);
    return hits
      .filter((h) => !isDoctrineExpired(payloadField(h.payload, "valid_until") || undefined))
      .slice(0, limit)
      .map((h) => ({
        text: payloadField(h.payload, "text"),
        source: payloadField(h.payload, "source"),
        score: h.score,
        classification: payloadField(h.payload, "classification", "unclassified"),
      }));
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
