import type { Logger } from "../logger.js";
import { errorMessage } from "../util/error.js";
import { fetchJson } from "../util/http.js";
import { DEFAULT_CHAT_MODEL } from "./models.js";

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
}

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

  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const payload = {
      model: req.model || this.model,
      messages: req.messages,
      tools: req.tools,
      tool_choice: req.tool_choice ?? "auto",
      temperature: req.temperature ?? 0.2,
      max_tokens: req.max_tokens ?? 512,
      stream: false,
      // ollama extension (ignored by other OpenAI servers): keep the model
      // resident for 2h so a !ask after a lull doesn't pay the cold-load tax.
      keep_alive: "6h",
    };

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
      throw new Error(`LLM request failed: ${errorMessage(err)}`);
    }
  }
}
