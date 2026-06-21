import type { Logger } from "../logger.js";
import { errorMessage } from "../util/error.js";
import { LlmClient, type ChatMessage } from "./client.js";
import { probeLlmEndpoint } from "./probe.js";

export const DELEGATE_TOOL_NAME = "delegate_to_agent" as const;

/** Immediate ack while the heavy model runs (DESIGN §R1b). */
export const DELEGATE_ACK_MESSAGE =
  "Analyst on it — I'll post the result here when ready.";

/** Prefix for the async follow-up posted to the channel. */
export function formatDelegateFollowUp(result: string, invokerName?: string): string {
  const label = invokerName ? `Analyst result (${invokerName})` : "Analyst result";
  return `📋 ${label}:\n${result}`;
}

export const ANALYST_SYSTEM_PROMPT =
  "You are a senior intelligence analyst supporting an operations channel. " +
  "Produce thorough, well-structured answers: use headings and bullets when helpful, " +
  "cite supplied context by source label, and state uncertainty plainly. " +
  "Reply in direct speech; no stage directions.";

export interface DelegateClientOptions {
  baseUrl: string;
  model?: string;
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

  constructor(options: DelegateClientOptions) {
    this.inner = new LlmClient({
      baseUrl: options.baseUrl,
      model: options.model,
      timeoutMs: options.timeoutMs ?? 300_000,
      logger: options.logger,
    });
  }

  getBaseUrl(): string {
    return this.inner.getBaseUrl();
  }

  async isAvailable(): Promise<boolean> {
    return probeLlmEndpoint(this.inner.getBaseUrl());
  }

  async complete(messages: ChatMessage[], temperature = 0.3): Promise<string> {
    const resp = await this.inner.chat({
      messages,
      tools: undefined,
      tool_choice: "none",
      temperature,
      max_tokens: 4096,
    });
    return resp.choices?.[0]?.message?.content?.trim() || "";
  }

  offlineMessage(): string {
    return "The analyst node is offline — try again later or use !ask for a quicker answer.";
  }

  failureMessage(err: unknown): string {
    return `Analyst request failed: ${errorMessage(err)}`;
  }
}