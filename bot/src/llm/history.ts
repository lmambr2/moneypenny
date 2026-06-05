/**
 * Per-conversation chat history with a token budget (DESIGN §9).
 *
 * RKLLM's context window is small (~2048 tokens), so history must be capped.
 * We keep a flat list of turns per conversation key and evict the OLDEST turns
 * once the estimated token total exceeds the budget. Eviction (not
 * summarization) keeps this deterministic and cheap — no extra LLM round-trip —
 * which matches the "cap per-channel history; evict on overflow" guidance.
 */

export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
}

/**
 * Rough token estimate. Real tokenization is model-specific and not worth a
 * dependency here; ~4 chars/token is the standard heuristic, plus a small
 * per-message overhead for role/formatting framing.
 */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4) + 4;
}

export interface ConversationStoreOptions {
  /** Token budget for retained history (excludes system prompt, tools, response). */
  maxTokens?: number;
  /** Hard cap on retained turns regardless of token math (safety bound). */
  maxTurns?: number;
  /** Override the token estimator (tests). */
  estimate?: (content: string) => number;
}

export class ConversationStore {
  private conversations = new Map<string, HistoryEntry[]>();
  private maxTokens: number;
  private maxTurns: number;
  private estimate: (content: string) => number;

  constructor(options: ConversationStoreOptions = {}) {
    // Default budget leaves headroom under a 2048 ctx for the system prompt,
    // the tool schema, and the model's reply.
    this.maxTokens = options.maxTokens ?? 1024;
    this.maxTurns = options.maxTurns ?? 20;
    this.estimate = options.estimate ?? estimateTokens;
  }

  /** Current retained history for a conversation (oldest → newest). */
  get(key: string): HistoryEntry[] {
    return this.conversations.get(key) ?? [];
  }

  /** Append a turn and evict oldest turns until back within budget. */
  append(key: string, entry: HistoryEntry): void {
    const list = this.conversations.get(key) ?? [];
    list.push(entry);
    this.trim(list);
    this.conversations.set(key, list);
  }

  /** Append several turns atomically (e.g. the user turn + assistant reply). */
  appendMany(key: string, entries: HistoryEntry[]): void {
    if (entries.length === 0) return;
    const list = this.conversations.get(key) ?? [];
    list.push(...entries);
    this.trim(list);
    this.conversations.set(key, list);
  }

  /** Drop a conversation entirely. */
  clear(key: string): void {
    this.conversations.delete(key);
  }

  /** Mutates `list` in place: evict from the front until within both caps. */
  private trim(list: HistoryEntry[]): void {
    // Turn cap first (cheap), then token budget.
    while (list.length > this.maxTurns) list.shift();
    let total = list.reduce((sum, e) => sum + this.estimate(e.content), 0);
    // Always keep at least the most recent turn, even if it alone exceeds the
    // budget — dropping it would send an empty/contextless request.
    while (list.length > 1 && total > this.maxTokens) {
      const removed = list.shift()!;
      total -= this.estimate(removed.content);
    }
  }
}
