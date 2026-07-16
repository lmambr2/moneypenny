import axios from "axios";
import type { Logger } from "../logger.js";
import { errorMessage } from "../util/error.js";
import { l2NormalizeBatch } from "./normalize.js";

/** SBC default: Nomic Embed v2 MoE on Ollama (English + multilingual, 768-d). */
export const DEFAULT_EMBEDDING_MODEL_SBC = "nomic-embed-text-v2-moe";
/** Server quality option: BGE large English (1024-d when served via Ollama). */
export const DEFAULT_EMBEDDING_MODEL_SERVER = "bge-large-en-v1.5";
/** Process/env default when edition not set — prefer SBC-friendly model. */
export const DEFAULT_EMBEDDING_MODEL = DEFAULT_EMBEDDING_MODEL_SBC;

export interface EmbeddingsClientOptions {
  /** OpenAI-compatible endpoint, e.g. http://ollama:11434 (local) or the remote GPU box. */
  baseUrl?: string;
  /** Embedding model id on the endpoint (Ollama tag / HF id). */
  model?: string;
  timeoutMs?: number;
  /** L2-normalize every vector (default true — cosine/TurboVec). */
  normalize?: boolean;
  logger?: Logger;
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model?: string;
}

/**
 * Thin embeddings client for any OpenAI-compatible `/v1/embeddings` endpoint
 * (ROADMAP Phase 5). Config-driven baseUrl/model:
 * - SBC: nomic-embed-text-v2-moe (fast, 768-d)
 * - Server: optional bge-large-en-v1.5 (quality)
 * Vectors are L2-normalized before return for cosine / TurboVec.
 */
export class EmbeddingsClient {
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private normalize: boolean;
  private logger?: Logger;
  private http: ReturnType<typeof axios.create>;
  private dim: number | null = null;
  /** Ollama on the Pi serves one embed at a time — serialize to avoid queue timeouts. */
  private embedQueue: Promise<unknown> = Promise.resolve();

  constructor(options: EmbeddingsClientOptions = {}) {
    this.baseUrl = (
      options.baseUrl ||
      process.env.EMBEDDING_URL ||
      process.env.RKLLAMA_URL ||
      "http://ollama:11434"
    ).replace(/\/$/, "");
    this.model =
      options.model ||
      process.env.EMBEDDING_MODEL ||
      defaultModelForEdition(process.env.MONEYPENNY_EDITION);
    // SBC CPU: large batches can take minutes when contended.
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.normalize = options.normalize !== false;
    this.logger = options.logger;
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** Embed one or more texts. Returns one vector per input, in input order. */
  async embed(input: string | string[]): Promise<number[][]> {
    const texts = Array.isArray(input) ? input : [input];
    if (texts.length === 0) return [];
    return this.enqueueEmbed(texts);
  }

  private enqueueEmbed(texts: string[]): Promise<number[][]> {
    const run = async (): Promise<number[][]> => {
      try {
        const { data } = await this.http.post<EmbeddingResponse>("/v1/embeddings", {
          model: this.model,
          input: texts,
          // ollama extension (ignored elsewhere): keep the embed model resident.
          keep_alive: "6h",
        });
        let out = (data.data ?? [])
          .slice()
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
          .map((d) => d.embedding);
        if (this.normalize) out = l2NormalizeBatch(out);
        if (out.length && this.dim == null) this.dim = out[0].length;
        return out;
      } catch (err: unknown) {
        this.logger?.warn(
          { err: errorMessage(err), baseUrl: this.baseUrl, model: this.model },
          "Embedding request failed",
        );
        throw new Error(`Embedding request failed: ${errorMessage(err)}`);
      }
    };
    const next = this.embedQueue.then(run, run);
    this.embedQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Vector dimension for the active model (probed once, cached) — sizes the collection. */
  async dimension(): Promise<number> {
    if (this.dim != null) return this.dim;
    const [v] = await this.embed("dimension probe");
    this.dim = v?.length ?? 0;
    return this.dim;
  }

  getModel(): string {
    return this.model;
  }
}

export function defaultModelForEdition(edition?: string): string {
  const e = (edition || "").trim().toLowerCase();
  if (e === "server") return DEFAULT_EMBEDDING_MODEL_SERVER;
  return DEFAULT_EMBEDDING_MODEL_SBC;
}
