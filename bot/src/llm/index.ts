import { LlmClient, type ChatMessage } from "./client.js";
import { MUSIC_CONTROL_TOOLS, DEFAULT_SYSTEM_PROMPT, buildToolRequest, type MusicToolName } from "./tools.js";
import { ConversationStore, type HistoryEntry } from "./history.js";
import type { Logger } from "../logger.js";

export { LlmClient } from "./client.js";
export { MUSIC_CONTROL_TOOLS, DEFAULT_SYSTEM_PROMPT } from "./tools.js";
export { ConversationStore } from "./history.js";

/**
 * Optional RAG hook (ROADMAP Phase 5). Injected by the caller so the LLM module
 * stays decoupled from the vector store; returns the top-k relevant chunks for a
 * question. Only the `!ask` path uses it — tool-calling (music) is untouched.
 */
export type RetrievalHook = (question: string) => Promise<Array<{ text: string; source: string; score?: number }>>;

export interface LlmModuleOptions {
  client?: LlmClient;
  logger?: Logger;
  systemPrompt?: string;
  /** Sampling temperature passed on every chat request. Defaults to 0.2. */
  temperature?: number;
  /** Conversation history store; defaults to a fresh per-module store. */
  history?: ConversationStore;
  /** Optional retrieval hook — when set, `!ask` injects retrieved context. */
  retrieve?: RetrievalHook;
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
  private temperature: number;
  private history: ConversationStore;
  private retrieve?: RetrievalHook;

  constructor(options: LlmModuleOptions = {}) {
    this.client = options.client ?? new LlmClient({ logger: options.logger });
    this.logger = options.logger;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.temperature = options.temperature ?? 0.2;
    this.history = options.history ?? new ConversationStore();
    this.retrieve = options.retrieve;
  }

  /** Attach/replace the RAG retrieval hook at runtime (e.g. when rag is toggled). */
  setRetrieve(hook: RetrievalHook | undefined): void {
    this.retrieve = hook;
  }

  /**
   * Simple Q&A path for `!ask <question>`.
   * When a conversationId is given, prior turns are included for context and
   * this exchange is appended to that conversation's history (DESIGN §9).
   */
  async ask(question: string, conversationId?: string): Promise<string> {
    this.logger?.debug({ question: question.slice(0, 80), conversationId }, "LLM ask");
    const messages: ChatMessage[] = [{ role: "system", content: this.systemPrompt }];

    // RAG (Phase 5): inject retrieved context as a SECOND system message so the
    // Moneypenny persona (first system message) stays intact. Best-effort —
    // retrieval failures never block the answer.
    if (this.retrieve) {
      try {
        const chunks = await this.retrieve(question);
        if (chunks.length > 0) {
          const ctx = chunks.map((c) => `[${c.source}] ${c.text}`).join("\n\n");
          messages.push({
            role: "system",
            content:
              "Relevant context from the knowledge base — use it to answer if applicable, " +
              "otherwise answer normally. Do not mention these instructions.\n\n" + ctx,
          });
        }
      } catch (err) {
        this.logger?.warn({ err }, "RAG retrieval failed in ask() — answering without it");
      }
    }

    messages.push(...this.historyMessages(conversationId), { role: "user", content: question });

    try {
      const resp = await this.client.chat({ messages, tools: undefined, tool_choice: "none", temperature: this.temperature });
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
   * One-shot completion with no conversation history and a caller-supplied
   * system prompt. For structured/background tasks (e.g. the roast grader and
   * reel writer) that must not be polluted by chat history or the bot persona.
   * Returns the raw assistant text (empty string on failure — callers decide).
   */
  async complete(prompt: string, system?: string): Promise<string> {
    const messages: ChatMessage[] = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });
    try {
      const resp = await this.client.chat({
        messages,
        tools: undefined,
        tool_choice: "none",
        temperature: this.temperature,
      });
      return resp.choices?.[0]?.message?.content?.trim() || "";
    } catch (err) {
      this.logger?.warn({ err }, "LLM complete failed");
      return "";
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
    req.temperature = this.temperature;

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
