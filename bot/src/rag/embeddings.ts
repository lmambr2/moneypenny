import axios from "axios";
import type { Logger } from "../logger.js";
import { errorMessage } from "../util/error.js";

export interface EmbeddingsClientOptions {
  /** OpenAI-compatible endpoint, e.g. http://ollama:11434 (local) or the remote GPU box. */
  baseUrl?: string;
  /** Gemma-family embeddings (default embeddinggemma on Pi and x86). */
  model?: string;
  timeoutMs?: number;
  logger?: Logger;
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model?: string;
}

/**
 * Thin embeddings client for any OpenAI-compatible `/v1/embeddings` endpoint
 * (ROADMAP Phase 5). Mirrors {@link LlmClient}: a config-driven baseUrl/model so
 * the SAME code serves both tracks — EmbeddingGemma on ollama-CPU (RK3588) or a
 * big Qwen3-Embedding on a GPU box — and the endpoint can be local or remote.
 */
export class EmbeddingsClient {
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
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
    this.model = options.model || process.env.EMBEDDING_MODEL || "embeddinggemma";
    // Pi CPU: embeddinggemma can take 3+ minutes per batch when contended.
    this.timeoutMs = options.timeoutMs ?? 600_000;
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
        const out = (data.data ?? [])
          .slice()
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
          .map((d) => d.embedding);
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
