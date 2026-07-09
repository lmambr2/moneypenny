import axios from "axios";
import type { Logger } from "../logger.js";
import { errorMessage } from "../util/error.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  LlmClient,
  type LlmClientOptions,
} from "./client.js";
import { probeLlmEndpoint } from "./probe.js";

export interface FallbackLlmClientOptions {
  primary: LlmClientOptions;
  fallbackUrl?: string;
  fallbackModel?: string;
  logger?: Logger;
}

export interface LlmEndpointHealth {
  primaryAvailable: boolean;
  fallbackAvailable: boolean;
  fallbackConfigured: boolean;
  /** True when the primary is down but the fallback responds. */
  activeFallback: boolean;
}

/** Errors where retrying on a secondary endpoint is worthwhile. */
export function isRetryableLlmError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) {
    const msg = errorMessage(err).toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("econnrefused") ||
      msg.includes("enotfound") ||
      msg.includes("network")
    );
  }
  if (
    err.code === "ECONNABORTED" ||
    err.code === "ECONNREFUSED" ||
    err.code === "ENOTFOUND" ||
    err.code === "ETIMEDOUT" ||
    err.code === "EHOSTUNREACH"
  ) {
    return true;
  }
  const status = err.response?.status;
  return status === 502 || status === 503 || status === 504 || status === 408;
}

/**
 * Primary/fallback chat client. Tries the primary endpoint first; on a
 * retryable failure, transparently retries once on the fallback (Pi ollama).
 */
export class FallbackLlmClient {
  private primary: LlmClient;
  private fallback?: LlmClient;
  private logger?: Logger;
  private lastUsedFallback = false;

  constructor(options: FallbackLlmClientOptions) {
    this.primary = new LlmClient({ ...options.primary, logger: options.logger });
    this.logger = options.logger;
    const fbUrl = options.fallbackUrl?.trim();
    if (fbUrl) {
      this.fallback = new LlmClient({
        baseUrl: fbUrl,
        model: options.fallbackModel,
        timeoutMs: options.primary.timeoutMs,
        logger: options.logger,
      });
    }
  }

  usedFallbackLast(): boolean {
    return this.lastUsedFallback;
  }

  getBaseUrl(): string {
    return this.primary.getBaseUrl();
  }

  async probeHealth(): Promise<LlmEndpointHealth> {
    const primaryUrl = this.primary.getBaseUrl();
    const fallbackUrl = this.fallback?.getBaseUrl() ?? "";
    const [primaryAvailable, fallbackAvailable] = await Promise.all([
      probeLlmEndpoint(primaryUrl),
      this.fallback ? probeLlmEndpoint(fallbackUrl) : Promise.resolve(false),
    ]);
    return {
      primaryAvailable,
      fallbackAvailable,
      fallbackConfigured: !!this.fallback,
      activeFallback: !primaryAvailable && fallbackAvailable,
    };
  }

  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    this.lastUsedFallback = false;
    try {
      return await this.primary.chat(req);
    } catch (err) {
      if (!this.fallback || !isRetryableLlmError(err)) throw err;
      this.logger?.warn(
        { err: errorMessage(err), fallbackUrl: this.fallback.getBaseUrl() },
        "Primary LLM failed — retrying on fallback",
      );
      this.lastUsedFallback = true;
      return this.fallback.chat(req);
    }
  }
}

export function createLlmClient(opts: {
  primary: LlmClientOptions;
  fallbackUrl?: string;
  fallbackModel?: string;
  logger?: Logger;
}): LlmClient | FallbackLlmClient {
  if (opts.fallbackUrl?.trim()) {
    return new FallbackLlmClient(opts);
  }
  return new LlmClient({ ...opts.primary, logger: opts.logger });
}
