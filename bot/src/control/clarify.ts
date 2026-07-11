/**
 * Clarify-once policy (P4): when fuzzy intent is ambiguous, ask one question
 * before executing tools.
 */

export type ClarifyDecision = { action: "proceed" } | { action: "clarify"; question: string };

export interface ToolCallLike {
  name: string;
  arguments?: Record<string, unknown>;
}

// Names must match the actual LLM tool names in llm/tools.ts (play_music,
// select_tracks, queue, stop, pause, skip, …) or the policy never fires.
/** Tools that start/queue playback. */
const START_TOOLS = new Set(["play_music", "select_tracks", "queue"]);
/** Tools that halt/alter the current track. */
const CONTROL_TOOLS = new Set(["stop", "pause", "skip"]);
/** Start tools whose `query` argument is required for a meaningful result. */
const QUERY_TOOLS = new Set(["play_music", "queue"]);

/**
 * Decide whether to clarify before running tools.
 * @param clarifyPending — true if we already asked once this turn/conversation.
 */
export function decideClarifyOnce(
  toolCalls: ToolCallLike[],
  opts: {
    enabled?: boolean;
    clarifyPending?: boolean;
    maxClarifyPerTurn?: number;
  } = {},
): ClarifyDecision {
  if (!opts.enabled) return { action: "proceed" };
  if (opts.clarifyPending) return { action: "proceed" };
  if ((opts.maxClarifyPerTurn ?? 1) < 1) return { action: "proceed" };

  if (toolCalls.length === 0) return { action: "proceed" };

  const names = toolCalls.map((t) => t.name.toLowerCase());

  // Play/queue without a query
  for (const tc of toolCalls) {
    const n = tc.name.toLowerCase();
    if (QUERY_TOOLS.has(n)) {
      const q = String(tc.arguments?.query ?? tc.arguments?.q ?? tc.arguments?.url ?? "").trim();
      if (!q) {
        return {
          action: "clarify",
          question: "What should I play? Give a title, artist, or link.",
        };
      }
    }
  }

  // Conflicting tools in one shot: start playback AND halt the current track
  if (toolCalls.length >= 2) {
    const hasStart = names.some((n) => START_TOOLS.has(n));
    const hasControl = names.some((n) => CONTROL_TOOLS.has(n));
    if (hasStart && hasControl) {
      return {
        action: "clarify",
        question:
          "Do you want me to play something, or control the current track (pause/stop/skip)?",
      };
    }
  }

  return { action: "proceed" };
}
