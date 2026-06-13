import { EmbeddingsClient } from "./embeddings.js";
import { QdrantClient, type QdrantPoint } from "./qdrant.js";
import { chunkMarkdown } from "./chunk.js";
import type { Logger } from "../logger.js";

export { EmbeddingsClient } from "./embeddings.js";
export { QdrantClient } from "./qdrant.js";

export interface RetrievedChunk {
  text: string;
  source: string;
  score: number;
}

export interface RetrievalStoreOptions {
  embeddings: EmbeddingsClient;
  qdrant: QdrantClient;
  collection: string;
  topK?: number;
  logger?: Logger;
}

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
  async ingest(source: string, text: string, metadata: Record<string, unknown> = {}): Promise<number> {
    await this.init();
    const chunks = chunkMarkdown(source, text);
    if (chunks.length === 0) return 0;
    const vectors = await this.embeddings.embed(chunks.map((c) => c.text));
    const points: QdrantPoint[] = chunks.map((c, i) => ({
      id: c.id,
      vector: vectors[i],
      payload: { text: c.text, source: c.source, index: c.index, ...metadata },
    }));
    await this.qdrant.deleteBySource(this.collection, source);
    await this.qdrant.upsert(this.collection, points);
    this.logger?.info({ source, chunks: points.length }, "Ingested document");
    return points.length;
  }

  /** Embed the query and return the top-k most similar chunks. Never throws into callers. */
  async query(text: string, topK?: number): Promise<RetrievedChunk[]> {
    if (!text?.trim()) return [];
    try {
      await this.init();
      const [vec] = await this.embeddings.embed(text);
      if (!vec) return [];
      const hits = await this.qdrant.search(this.collection, vec, topK ?? this.topK);
      return hits.map((h) => ({
        text: String((h.payload as any)?.text ?? ""),
        source: String((h.payload as any)?.source ?? ""),
        score: h.score,
      }));
    } catch (err) {
      this.logger?.warn({ err }, "RAG query failed — answering without retrieved context");
      return [];
    }
  }
}
