/**
 * Harness intent tool policy (audit M-2026-07-09-1).
 * Safer default allowlist; dry-run skips executor entirely.
 */

/** Tools allowed by default in harness intent (no stop/vol/move). */
export const HARNESS_SAFE_TOOLS = new Set([
  "play_music",
  "queue",
  "select_tracks",
  "skip",
  "pause",
  "resume",
  "now_playing",
]);

/** Tools that require harnessIntentAllowDangerous. */
export const HARNESS_DANGEROUS_TOOLS = new Set([
  "stop",
  "set_volume",
  "move_client",
  "move_all_clients",
  "delegate_to_agent",
]);

export interface HarnessToolPolicyOpts {
  /** When true, tools are not executed — recorded as dry-run. Default false. */
  dryRun?: boolean;
  /** When true, allow stop/vol/move tools. Default false. */
  allowDangerous?: boolean;
  /** Optional explicit allowlist (overrides safe set when provided). */
  allowlist?: string[];
}

export type HarnessToolDecision =
  | { action: "execute" }
  | { action: "dry_run" }
  | { action: "block"; reason: string };

export function decideHarnessTool(
  toolName: string,
  opts: HarnessToolPolicyOpts = {},
): HarnessToolDecision {
  if (opts.dryRun) {
    return { action: "dry_run" };
  }

  const allowed = opts.allowlist
    ? new Set(opts.allowlist)
    : opts.allowDangerous
      ? new Set([...HARNESS_SAFE_TOOLS, ...HARNESS_DANGEROUS_TOOLS])
      : HARNESS_SAFE_TOOLS;

  if (!allowed.has(toolName)) {
    return {
      action: "block",
      reason: opts.allowDangerous
        ? `tool not allowed: ${toolName}`
        : `tool blocked by harness safety policy (enable allowDangerous for stop/vol/move): ${toolName}`,
    };
  }
  return { action: "execute" };
}
