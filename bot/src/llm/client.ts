import type { Logger } from "../logger.js";
import { errorMessage } from "../util/error.js";
import { fetchJson, fetchWithTimeout, HttpRequestError } from "../util/http.js";
import { DEFAULT_CHAT_MODEL } from "./models.js";

/**
 * Output caps. These are generation limits, not context.
 * Voice stays short; typed !ask may brief at length.
 */
export const LLM_DEFAULT_MAX_TOKENS = 8192;
export const LLM_ASK_MAX_TOKENS = 16_384;
export const LLM_INTENT_MAX_TOKENS = 1024;
export const LLM_VOICE_MAX_TOKENS = 384;
export const LLM_DELEGATE_MAX_TOKENS = 16_384;

/** Penny (GPU 1) stays hot. Desk (GPU 0) yields for games. */
export const LLM_PENNY_KEEP_ALIVE = "24h";
export const LLM_DESK_KEEP_ALIVE = "5m";

/** Never default 256k. Voice 8k, typed !ask 32k. */
export const LLM_VOICE_NUM_CTX = 8192;
export const LLM_ASK_NUM_CTX = 32_768;

export interface LlmClientOptions {
  baseUrl?: string; // RKLLama OpenAI-compatible endpoint, e.g. http://localhost:8080
  model?: string;
  timeoutMs?: number;
  logger?: Logger;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/** OpenAI-compatible function tool definition for chat completions. */
export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  /** Cancels the HTTP request itself — without it a timed-out caller leaves the completion burning CPU. */
  signal?: AbortSignal;
  /** Ollama keep_alive (ignored elsewhere). Default 24h on the penny client. */
  keepAlive?: string;
  /** Ollama/llama.cpp context window. Voice 8k, !ask 32k. */
  numCtx?: number;
  /** Gemma reasoning / Ollama `think`. Banned on voice; optional on !ask. */
  think?: boolean;
  /**
   * Hint flash-attention (+ Gemma 4 MTP drafter when the build supports it).
   * Unknown keys are ignored by OpenAI-compatible servers.
   */
  flashAttention?: boolean;
  stream?: boolean;
}

export type ChatStreamEvent =
  | { type: "text"; text: string }
  | {
      type: "done";
      content: string;
      reasoning: string;
      toolCalls: ToolCall[];
    };

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      /** Some Gemma/Ollama builds put the answer here when content is empty. */
      reasoning?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Prefer message.content; if empty (common on Gemma-4 reasoning models), salvage a
 * spoken line from `reasoning`. Strips markdown fences / bullet thinking noise.
 */
export function extractAssistantText(message: {
  content?: string | null;
  reasoning?: string | null;
}): string {
  const fromContent = (message.content ?? "").trim();
  if (fromContent) return stripAssistantNoise(fromContent);

  const reasoning = (message.reasoning ?? "").trim();
  if (!reasoning) return "";

  // Walk upward for the last plain spoken-looking line (skip * bullets / headers).
  const lines = reasoning
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let l = lines[i]!;
    l = l.replace(/^["'`]+|["'`]+$/g, "").trim();
    if (l.length < 8 || l.length > 600) continue;
    if (/^[*\-#•]/.test(l)) continue;
    if (/^(constraint|role|tone|thinking|note|step|rule)\b/i.test(l)) continue;
    if (/^[*\s]*\d+[.)]\s/.test(l)) continue;
    return stripAssistantNoise(l);
  }
  return "";
}

function stripAssistantNoise(text: string): string {
  let t = text.trim();
  // Drop ``` fences if the model wraps the line.
  t = t.replace(/^```(?:\w+)?\s*/i, "").replace(/\s*```$/i, "");
  // Drop leading "Spoken line:" style labels.
  t = t.replace(/^(spoken line|bumper|announcement)\s*:\s*/i, "");
  // Prompt-echo filtering is deliberately NOT done here: this strips output for
  // every consumer (!ask, voice replies, delegates), and a legitimate short
  // answer can mention "provided text" or "no markdown". Bumper callers filter
  // meta echoes at their own layer via isMetaBumperScript/cleanBumperScript.
  return t.trim();
}

/**
 * Thin client for RKLLama (or any OpenAI-compatible /v1/chat/completions endpoint).
 * Designed for Phase 1b per DESIGN §9: in-process, minimal, NPU-backed via RKLLama.
 */
export class LlmClient {
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private logger?: Logger;

  constructor(options: LlmClientOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.RKLLAMA_URL || "http://localhost:8080").replace(
      /\/$/,
      "",
    );
    this.model = options.model || process.env.RKLLAMA_MODEL || DEFAULT_CHAT_MODEL;
    // 180s: on the Pi, !ask chains embed (nomic/bge) then chat (Gemma).
    // Cold load + ~10 tok/s decode can exceed 120s when both models contend.
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.logger = options.logger;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private buildPayload(req: ChatCompletionRequest, stream: boolean): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: req.model || this.model,
      messages: req.messages,
      tools: req.tools,
      tool_choice: req.tool_choice ?? "auto",
      temperature: req.temperature ?? 0.2,
      max_tokens: req.max_tokens ?? LLM_DEFAULT_MAX_TOKENS,
      stream,
      // ollama extension (ignored by other OpenAI servers).
      keep_alive: req.keepAlive ?? LLM_PENNY_KEEP_ALIVE,
    };
    if (req.think !== undefined) payload.think = req.think;
    const options: Record<string, unknown> = {};
    if (req.numCtx) options.num_ctx = req.numCtx;
    if (req.flashAttention) options.flash_attention = true;
    if (Object.keys(options).length > 0) payload.options = options;
    return payload;
  }

  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const payload = this.buildPayload(req, false);

    try {
      return await fetchJson<ChatCompletionResponse>(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        timeoutMs: this.timeoutMs,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: req.signal,
      });
    } catch (err: unknown) {
      this.logger?.warn(
        { err: errorMessage(err), baseUrl: this.baseUrl },
        "LLM chat request failed",
      );
      // Rethrow as-is so HttpRequestError.status reaches FallbackLlmClient.
      throw err;
    }
  }

  /**
   * Stream assistant text deltas (OpenAI SSE). Used on voice turns so TTS can
   * start on the first complete sentence while 12B is still generating.
   */
  async *chatStream(req: ChatCompletionRequest): AsyncIterable<ChatStreamEvent> {
    const payload = this.buildPayload(req, true);
    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        timeoutMs: this.timeoutMs,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: req.signal,
      });
    } catch (err: unknown) {
      this.logger?.warn(
        { err: errorMessage(err), baseUrl: this.baseUrl },
        "LLM stream request failed",
      );
      throw err;
    }
    if (!res.ok) {
      let body: string | undefined;
      try {
        body = (await res.text()).trim() || undefined;
      } catch {
        /* ignore */
      }
      throw new HttpRequestError(`HTTP ${res.status} ${res.statusText}`, {
        status: res.status,
        body,
      });
    }
    if (!res.body) {
      throw new HttpRequestError("LLM stream had no body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    let reasoning = "";
    const toolCalls: ToolCall[] = [];

    const consumeLine = (line: string): ChatStreamEvent | null => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return null;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") return null;
      let json: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      try {
        json = JSON.parse(data) as typeof json;
      } catch {
        return null;
      }
      const delta = json.choices?.[0]?.delta;
      if (!delta) return null;
      if (delta.tool_calls?.length) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? toolCalls.length;
          const cur = toolCalls[idx] ?? {
            id: tc.id || `call_${idx}`,
            type: "function" as const,
            function: { name: "", arguments: "" },
          };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          toolCalls[idx] = cur;
        }
      }
      if (typeof delta.reasoning === "string" && delta.reasoning) {
        reasoning += delta.reasoning;
      }
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        return { type: "text", text: delta.content };
      }
      return null;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const ev = consumeLine(line);
          if (ev) yield ev;
        }
      }
      if (buf.trim()) {
        const ev = consumeLine(buf);
        if (ev) yield ev;
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: "done", content, reasoning, toolCalls: toolCalls.filter(Boolean) };
  }
}
