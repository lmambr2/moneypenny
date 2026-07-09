import { parseCommand } from "../bot/commands.js";
import type { RouterDecision } from "../control/router.js";

/** Commands that may trigger slow music resolve (YouTube search, library scan). */
export const MUSIC_SEARCH_COMMANDS = new Set([
  "play",
  "add",
  "playnext",
  "pn",
  "playlist",
  "album",
]);

export function musicSearchCommandName(name: string, aliases: Record<string, string> = {}): string {
  const parsed = parseCommand(`!${name}`, "!", aliases);
  if (!parsed) return name;
  return parsed.name.replace(/[.,!?;:]+$/u, "");
}

/** True when voice text will likely start a music lookup (not bare transport). */
export function isMusicSearchRouteText(
  text: string,
  aliases: Record<string, string> = {},
): boolean {
  const parsed = parseCommand(`!${text.trim()}`, "!", aliases);
  if (!parsed) return false;
  const name = parsed.name.replace(/[.,!?;:]+$/u, "");
  return MUSIC_SEARCH_COMMANDS.has(name);
}

/** Speak an instant ack before async resolve for these routes. */
export function voiceRouteNeedsPendingAck(
  decision: RouterDecision,
  routeText: string,
  aliases: Record<string, string> = {},
): boolean {
  if (decision.type === "deterministic" && decision.command) {
    const name = decision.command.name.replace(/[.,!?;:]+$/u, "");
    return MUSIC_SEARCH_COMMANDS.has(name);
  }
  if (decision.type === "llm" && decision.llmIntent?.mode === "intent") {
    return isMusicSearchRouteText(routeText, aliases);
  }
  return false;
}
