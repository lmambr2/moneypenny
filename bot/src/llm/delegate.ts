import type { Logger } from "../logger.js";
import { errorMessage } from "../util/error.js";
import { type ChatMessage, extractAssistantText, LlmClient } from "./client.js";
import { probeLlmEndpoint } from "./probe.js";

export const DELEGATE_TOOL_NAME = "delegate_to_agent" as const;

/** Immediate ack while the heavy model runs (DESIGN §R1b). */
export const DELEGATE_ACK_MESSAGE = "Analyst on it — I'll post the result here when ready.";

/** Prefix for the async follow-up posted to the channel. */
export function formatDelegateFollowUp(result: string, invokerName?: string): string {
  const label = invokerName ? `Analyst result (${invokerName})` : "Analyst result";
  return `📋 ${label}:\n${result}`;
}

export const ANALYST_SYSTEM_PROMPT =
  "You are Colonel Moneypenny acting as senior intelligence analyst for this operations channel. " +
  "Field-grade manner: thorough, well-structured answers; headings and bullets when helpful; " +
  "cite supplied context by source label; state uncertainty plainly. " +
  "You do not outrank the Chairman. Reply in direct speech; no stage directions.";

export interface DelegateClientOptions {
  baseUrl: string;
  model?: string;
  /**
   * Lighter model on the SAME endpoint, tried once when `model` cannot be
   * served. On a single-GPU host the heavy model is the first thing to fail:
   * a 31B Q4 needs ~18.5GB, so anything else holding VRAM (a game, another
   * model) makes it unloadable while the ~7GB primary still fits. A degraded
   * answer beats "Analyst request failed".
   */
  fallbackModel?: string;
  timeoutMs?: number;
  logger?: Logger;
}

/**
 * Heavy-model client for DESIGN §R1 delegation — separate from the fast
 * primary/fallback chat chain so long-context work never contends with music
 * intent or quick !ask replies.
 */
export class DelegateClient {
  private inner: LlmClient;
  private lighter?: LlmClient;
  private logger?: Logger;
  private degraded = false;

  constructor(options: DelegateClientOptions) {
    this.logger = options.logger;
    this.inner = new LlmClient({
      baseUrl: options.baseUrl,
      model: options.model,
      timeoutMs: options.timeoutMs ?? 300_000,
      logger: options.logger,
    });
    const fb = options.fallbackModel?.trim();
    // Only meaningful as a *different* model; same-model retry buys nothing.
    if (fb && fb !== options.model?.trim()) {
      this.lighter = new LlmClient({
        baseUrl: options.baseUrl,
        model: fb,
        timeoutMs: options.timeoutMs ?? 300_000,
        logger: options.logger,
      });
    }
  }

  /** True when the last completion was served by the lighter model. */
  isDegraded(): boolean {
    return this.degraded;
  }

  getBaseUrl(): string {
    return this.inner.getBaseUrl();
  }

  async isAvailable(): Promise<boolean> {
    return probeLlmEndpoint(this.inner.getBaseUrl());
  }

  async complete(messages: ChatMessage[], temperature = 0.3): Promise<string> {
    const send = async (client: LlmClient): Promise<string> => {
      const resp = await client.chat({
        messages,
        tools: undefined,
        tool_choice: "none",
        temperature,
        max_tokens: 4096,
      });
      const msg = resp.choices?.[0]?.message;
      if (!msg) return "";
      // Gemma may fill reasoning when content is empty — same salvage as LlmModule.ask.
      return extractAssistantText(msg);
    };

    try {
      const text = await send(this.inner);
      this.degraded = false;
      return text;
    } catch (err) {
      if (!this.lighter) throw err;
      // Heavy model unreachable/unloadable — answer with the lighter one rather
      // than failing the whole analyst request.
      this.logger?.warn(
        { err },
        "Delegate heavy model failed — retrying on the lighter fallback model",
      );
      const text = await send(this.lighter);
      this.degraded = true;
      return text;
    }
  }

  offlineMessage(): string {
    return "The analyst node is offline — try again later or use !ask for a quicker answer.";
  }

  failureMessage(err: unknown): string {
    return `Analyst request failed: ${errorMessage(err)}`;
  }
}
