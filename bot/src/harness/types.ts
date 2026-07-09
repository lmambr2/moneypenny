/**
 * Harness cockpit turn model (docs/feature-roadmap.md H1/H2/H5).
 * Shared by the admin dashboard panel and POST /api/bot/harness/ask.
 */

export interface HarnessSource {
  source: string;
  text?: string;
  classification?: string;
  score?: number;
}

export interface HarnessToolRecord {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: string;
  error?: string;
}

export type HarnessMode = "ask" | "intent";

export interface HarnessTurn {
  id: string;
  at: number;
  user: string;
  reply: string;
  sources: HarnessSource[];
  tools: HarnessToolRecord[];
  error?: string;
  mode: HarnessMode;
}

export interface HarnessRetrieveChunk {
  text: string;
  source: string;
  score?: number;
  classification?: string;
}

export interface HarnessLlm {
  /** Grounded Q&A; may throw or return friendly error text. */
  ask(question: string, conversationId?: string): Promise<string>;
  /** Fuzzy intent with optional tool calls. */
  chatForIntent?(
    userMessage: string,
    conversationId?: string,
  ): Promise<{
    content: string | null;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  }>;
}

export interface RunHarnessTurnDeps {
  llm: HarnessLlm | null;
  /** RAG (+ optional org KG) chunks with classification when available. */
  retrieve?: (question: string) => Promise<HarnessRetrieveChunk[]>;
  /**
   * Optional tool executor for intent mode. Never throws into music transport —
   * return { ok:false } on failure.
   */
  executeTool?: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ ok: boolean; result?: string; error?: string }>;
  /** Ring-buffer store; optional. */
  store?: HarnessTurnStore;
  conversationId?: string;
  idFactory?: () => string;
  now?: () => number;
}

export interface HarnessTurnStore {
  push(turn: HarnessTurn): void;
  list(limit?: number): HarnessTurn[];
  clear(): void;
}
