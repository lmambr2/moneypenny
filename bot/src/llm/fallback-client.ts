import type { Logger } from "../logger.js";
import { errorMessage, httpStatus } from "../util/error.js";
import { isHttpRequestError } from "../util/http.js";
import {
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatStreamEvent,
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

/** Which endpoint served the most recent completion. */
export interface LlmRoute {
  route: "primary" | "fallback" | "none";
  /** epoch ms of that completion; 0 when nothing has run yet. */
  at: number;
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
  const msg = errorMessage(err).toLowerCase();
  if (
    msg.includes("timeout") ||
    msg.includes("aborted") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("network") ||
    msg.includes("fetch failed")
  ) {
    return true;
  }
  const status = httpStatus(err) ?? (isHttpRequestError(err) ? err.status : undefined);
  return status === 429 || status === 502 || status === 503 || status === 504 || status === 408;
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
  /** Ground truth about what actually served the last completion. */
  private lastRoute: LlmRoute = { route: "none", at: 0 };

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

  /**
   * What actually served the most recent completion, and when.
   *
   * Reported by /api/health so a silent downgrade to the fallback is visible
   * without probing. Probing there would be wrong: the endpoint is
   * unauthenticated and drives the Docker healthcheck, so an unreachable
   * primary (8s timeout, observed) could stall the check and trigger a restart.
   * This is observed history — free to read, and truer than a probe.
   */
  getLastRoute(): LlmRoute {
    return { ...this.lastRoute };
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
      const res = await this.primary.chat(req);
      this.lastRoute = { route: "primary", at: Date.now() };
      return res;
    } catch (err) {
      if (!this.fallback || !isRetryableLlmError(err)) throw err;
      this.logger?.warn(
        { err: errorMessage(err), fallbackUrl: this.fallback.getBaseUrl() },
        "Primary LLM failed — retrying on fallback",
      );
      this.lastUsedFallback = true;
      const res = await this.fallback.chat(req);
      this.lastRoute = { route: "fallback", at: Date.now() };
      return res;
    }
  }

  async *chatStream(req: ChatCompletionRequest): AsyncIterable<ChatStreamEvent> {
    this.lastUsedFallback = false;
    try {
      const iter = this.primary.chatStream(req);
      let first = true;
      for await (const ev of iter) {
        if (first) {
          this.lastRoute = { route: "primary", at: Date.now() };
          first = false;
        }
        yield ev;
      }
    } catch (err) {
      if (!this.fallback || !isRetryableLlmError(err)) throw err;
      this.logger?.warn(
        { err: errorMessage(err), fallbackUrl: this.fallback.getBaseUrl() },
        "Primary LLM stream failed — retrying on fallback",
      );
      this.lastUsedFallback = true;
      this.lastRoute = { route: "fallback", at: Date.now() };
      yield* this.fallback.chatStream(req);
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
