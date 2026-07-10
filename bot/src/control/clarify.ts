/**
 * Clarify-once policy (P4): when fuzzy intent is ambiguous, ask one question
 * before executing tools.
 */

export type ClarifyDecision = { action: "proceed" } | { action: "clarify"; question: string };

export interface ToolCallLike {
  name: string;
  arguments?: Record<string, unknown>;
}

/** Conflicting transport / playback tools that should not fire together. */
const CONFLICT_GROUPS: string[][] = [
  ["play", "stop", "pause", "resume"],
  ["play", "skip", "next"],
  ["vol", "volume", "stop"],
];

function groupIndex(name: string): number {
  const n = name.toLowerCase();
  for (let i = 0; i < CONFLICT_GROUPS.length; i++) {
    if (CONFLICT_GROUPS[i]!.includes(n)) return i;
  }
  return -1;
}

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

  // play without query
  for (const tc of toolCalls) {
    const n = tc.name.toLowerCase();
    if (n === "play" || n === "queue" || n === "search") {
      const q = String(tc.arguments?.query ?? tc.arguments?.q ?? tc.arguments?.url ?? "").trim();
      if (!q) {
        return {
          action: "clarify",
          question: "What should I play? Give a title, artist, or link.",
        };
      }
    }
  }

  // Conflicting tools in one shot
  if (toolCalls.length >= 2) {
    const groups = new Set(toolCalls.map((t) => groupIndex(t.name)).filter((g) => g >= 0));
    const names = toolCalls.map((t) => t.name.toLowerCase());
    const hasPlay = names.some((n) => n === "play" || n === "queue");
    const hasStop = names.some((n) => n === "stop" || n === "pause");
    if ((hasPlay && hasStop) || groups.size > 1) {
      return {
        action: "clarify",
        question:
          "Do you want me to play something, or control the current track (pause/stop/skip)?",
      };
    }
  }

  return { action: "proceed" };
}
