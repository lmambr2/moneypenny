/**
 * Clarify-once service (PR-A4). Injectable façade over decideClarifyOnce.
 * Default is in-memory; swap for Redis later without touching the router.
 */
import {
  decideClarifyOnce,
  type ClarifyDecision,
  type ToolCallLike,
} from "./clarify.js";

export interface ClarifyService {
  /** Whether clarify-once is enabled. */
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  /**
   * Apply clarify-once for this invoker/conversation.
   * Updates internal pending state when a clarify question is issued.
   */
  evaluate(
    pendingKey: string,
    toolCalls: ToolCallLike[],
  ): ClarifyDecision;
  /** Clear pending for a key (after proceed / answer). */
  clearPending(pendingKey: string): void;
}

const DEFAULT_TTL_MS = 10 * 60_000;

/** In-memory clarify-once (current production behavior). */
export class MemoryClarifyService implements ClarifyService {
  private enabled = false;
  /** pendingKey → ask timestamp */
  private pending = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(opts?: { ttlMs?: number }) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  clearPending(pendingKey: string): void {
    this.pending.delete(pendingKey);
  }

  evaluate(pendingKey: string, toolCalls: ToolCallLike[]): ClarifyDecision {
    this.expireStale();
    const decision = decideClarifyOnce(toolCalls, {
      enabled: this.enabled,
      clarifyPending: this.pending.has(pendingKey),
    });
    if (decision.action === "clarify") {
      this.pending.set(pendingKey, Date.now());
    } else {
      this.pending.delete(pendingKey);
    }
    return decision;
  }

  private expireStale(): void {
    const now = Date.now();
    for (const [key, asked] of this.pending) {
      if (now - asked > this.ttlMs) this.pending.delete(key);
    }
  }
}

/** Build pending key (conversation + invoker) — shared with router. */
export function clarifyPendingKey(
  conversationId: string | undefined,
  invokerUid: string | undefined,
  invokerName: string | undefined,
): string {
  const conv = conversationId ?? "default";
  const invoker = invokerUid ?? invokerName ?? "anon";
  return `${conv}::${invoker}`;
}
