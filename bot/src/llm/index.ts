import { LlmClient, type ChatMessage } from "./client.js";
import { MUSIC_CONTROL_TOOLS, DEFAULT_SYSTEM_PROMPT, buildToolRequest, type MusicToolName } from "./tools.js";
import { ConversationStore, type HistoryEntry } from "./history.js";
import type { Logger } from "../logger.js";

export { LlmClient } from "./client.js";
export { MUSIC_CONTROL_TOOLS, DEFAULT_SYSTEM_PROMPT } from "./tools.js";
export { ConversationStore } from "./history.js";

export interface LlmModuleOptions {
  client?: LlmClient;
  logger?: Logger;
  systemPrompt?: string;
  /** Conversation history store; defaults to a fresh per-module store. */
  history?: ConversationStore;
}

/**
 * High-level LLM module for Moneypenny (Phase 1b).
 * Wraps the low-level client + tool schema + per-conversation history.
 * This is the seam the ControlRouter calls for fuzzy intent and `!ask`.
 */
export class LlmModule {
  private client: LlmClient;
  private logger?: Logger;
  private systemPrompt: string;
  private history: ConversationStore;

  constructor(options: LlmModuleOptions = {}) {
    this.client = options.client ?? new LlmClient({ logger: options.logger });
    this.logger = options.logger;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.history = options.history ?? new ConversationStore();
  }

  /**
   * Simple Q&A path for `!ask <question>`.
   * When a conversationId is given, prior turns are included for context and
   * this exchange is appended to that conversation's history (DESIGN §9).
   */
  async ask(question: string, conversationId?: string): Promise<string> {
    this.logger?.debug({ question: question.slice(0, 80), conversationId }, "LLM ask");
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      ...this.historyMessages(conversationId),
      { role: "user", content: question },
    ];

    try {
      const resp = await this.client.chat({ messages, tools: undefined, tool_choice: "none" });
      const content = resp.choices?.[0]?.message?.content?.trim() || "(no response)";
      this.record(conversationId, question, content);
      return content;
    } catch (err) {
      this.logger?.warn({ err }, "LLM ask failed");
      // Don't persist failed turns — keep history clean for the retry.
      return "Sorry, the local brain is having a moment. Try again in a few seconds.";
    }
  }

  /**
   * Send a message that may trigger tool calls for music control.
   * Returns either plain text or the parsed tool_calls from the model.
   * History (if a conversationId is given) gives follow-ups like
   * "play another one like that" the context they need.
   */
  async chatForIntent(userMessage: string, conversationId?: string): Promise<{
    content: string | null;
    toolCalls?: Array<{ name: string; arguments: any }>;
  }> {
    const messages: ChatMessage[] = [
      ...this.historyMessages(conversationId),
      { role: "user", content: userMessage },
    ];
    const req = buildToolRequest(messages, { systemPrompt: this.systemPrompt });

    try {
      const resp = await this.client.chat(req);
      const choice = resp.choices?.[0];
      const msg = choice?.message;

      if (msg?.tool_calls && msg.tool_calls.length > 0) {
        const parsed = msg.tool_calls.map((tc) => {
          try {
            return {
              name: tc.function.name as MusicToolName,
              arguments: JSON.parse(tc.function.arguments || "{}"),
            };
          } catch {
            return { name: tc.function.name as MusicToolName, arguments: {} };
          }
        });
        // Record a compact assistant turn so follow-ups have context even when
        // the model replied only with tool calls (no natural-language content).
        this.record(conversationId, userMessage, msg.content?.trim() || summarizeToolCalls(parsed));
        return { content: msg.content, toolCalls: parsed };
      }

      const content = msg?.content?.trim() || null;
      if (content) this.record(conversationId, userMessage, content);
      return { content };
    } catch (err) {
      this.logger?.warn({ err }, "LLM intent chat failed");
      return { content: null };
    }
  }

  /** Forget a conversation's history (e.g. on bot disconnect or explicit reset). */
  resetConversation(conversationId: string): void {
    this.history.clear(conversationId);
  }

  /**
   * Health check (useful for web UI status later).
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Very light probe — many OpenAI compat servers support /v1/models
      await this.client["axiosInstance"].get("/v1/models", { timeout: 1500 });
      return true;
    } catch {
      return false;
    }
  }

  private historyMessages(conversationId?: string): ChatMessage[] {
    if (!conversationId) return [];
    return this.history.get(conversationId).map((e) => ({ role: e.role, content: e.content }));
  }

  private record(conversationId: string | undefined, user: string, assistant: string): void {
    if (!conversationId) return;
    const turns: HistoryEntry[] = [
      { role: "user", content: user },
      { role: "assistant", content: assistant },
    ];
    this.history.appendMany(conversationId, turns);
  }
}

/** Compact, token-cheap description of tool calls for history retention. */
function summarizeToolCalls(calls: Array<{ name: string; arguments: any }>): string {
  return calls
    .map((c) => {
      const args = c.arguments && Object.keys(c.arguments).length > 0 ? JSON.stringify(c.arguments) : "";
      return `[called ${c.name}${args ? `(${args})` : "()"}]`;
    })
    .join(" ");
}

// Singleton-friendly factory (wired in bot/manager or index later)
let _instance: LlmModule | null = null;

export function getLlmModule(logger?: Logger): LlmModule {
  if (!_instance) {
    _instance = new LlmModule({ logger });
  }
  return _instance;
}
