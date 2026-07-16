import { errEnvelope } from "./result.js";
import type { McpContext, McpToolEnvelope } from "./types.js";

/** High-impact tools that require `confirm: true` when requireConfirm is on. */
export const HIGH_IMPACT_TOOLS = new Set([
  "music_ban",
  "music_stop",
  "music_clear",
  "mod_mute",
  "mod_kick",
]);

/**
 * Returns a NEEDS_CONFIRMATION envelope if the tool is high-impact and the
 * caller did not pass confirm: true. Otherwise null (proceed).
 */
export function checkConfirm(
  ctx: McpContext,
  toolName: string,
  args: Record<string, unknown>,
  botId?: string,
): McpToolEnvelope | null {
  if (!ctx.config.requireConfirm) return null;
  if (!HIGH_IMPACT_TOOLS.has(toolName)) return null;
  if (args.confirm === true) return null;
  return errEnvelope(
    ctx,
    "NEEDS_CONFIRMATION",
    `Tool '${toolName}' is high-impact. Re-call with confirm: true after operator approval.`,
    botId,
  );
}
