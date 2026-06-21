import axios from "axios";
import type { Logger } from "../logger.js";
import { errorMessage } from "../util/error.js";
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
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
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
 * Thin client for RKLLama (or any OpenAI-compatible /v1/chat/completions endpoint).
 * Designed for Phase 1b per DESIGN §9: in-process, minimal, NPU-backed via RKLLama.
 */
export class LlmClient {
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private logger?: Logger;
  private axiosInstance: ReturnType<typeof axios.create>;

  constructor(options: LlmClientOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.RKLLAMA_URL || "http://localhost:8080").replace(/\/$/, "");
    this.model = options.model || process.env.RKLLAMA_MODEL || DEFAULT_CHAT_MODEL;
    // 180s: on the Pi, !ask chains embed (embeddinggemma) then chat (Gemma).
    // Cold load + ~10 tok/s decode can exceed 120s when both models contend.
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.logger = options.logger;

    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
      headers: { "Content-Type": "application/json" },
    });
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
      const { data } = await this.axiosInstance.post<ChatCompletionResponse>("/v1/chat/completions", payload);
      return data;
    } catch (err: unknown) {
      this.logger?.warn({ err: errorMessage(err), baseUrl: this.baseUrl }, "LLM chat request failed");
      throw new Error(`LLM request failed: ${errorMessage(err)}`);
    }
  }

  /**
   * Convenience: simple text Q&A (no tools).
   */
  async ask(prompt: string, systemPrompt?: string): Promise<string> {
    const messages: ChatMessage[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const resp = await this.chat({ messages, tools: undefined, tool_choice: "none" });
    const content = resp.choices?.[0]?.message?.content?.trim();
    return content || "(no response)";
  }
}
