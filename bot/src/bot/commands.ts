export interface ParsedCommand {
  name: string;
  args: string;
  rawArgs: string[];
  flags: Set<string>;
}

export const PUBLIC_COMMANDS = new Set([
  "play", "add", "queue", "list", "now", "lyrics", "vote", "help",
  "playlist", "album", "prev", "next", "skip", "pause", "resume",
  "artist", "ask", "analyst", "agent", "intsum", "aar", "test",
  "roast", "roastout",
  "remember", "recall", "forget",
  "kg", "diary",
  "chevron7", // easter egg: dials the SG-1 theme
  "radio", // radio/DJ mode — status is public; on/off gated by radio.power (below)
]);

export const ADMIN_COMMANDS = new Set([
  "stop", "clear", "move", "moveclient", "moveall", "vol", "mode", "follow", "remove",
  "reindex", "ingeststatus",
  // Token (not a typed command): `!radio on/off` is gated on this in the router.
  "radio.power",
]);

/**
 * Whether a parsed command name is a real, recognized command (public or admin).
 * The ControlRouter uses this to decide between deterministic dispatch and the
 * LLM fuzzy-intent fallback: a prefixed input whose name is NOT a known command
 * is treated as natural-language music intent (DESIGN §4/§9).
 */
export function isKnownCommand(commandName: string): boolean {
  return PUBLIC_COMMANDS.has(commandName) || ADMIN_COMMANDS.has(commandName);
}

export function parseCommand(
  message: string,
  prefix: string,
  aliases: Record<string, string> = {},
): ParsedCommand | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith(prefix)) return null;

  const withoutPrefix = trimmed.slice(prefix.length);
  if (!withoutPrefix) return null;

  const parts = withoutPrefix.split(/\s+/);
  let name = parts[0].toLowerCase();

  if (aliases[name]) {
    name = aliases[name];
  }

  const flags = new Set<string>();
  const argParts: string[] = [];

  for (let i = 1; i < parts.length; i++) {
    if (
      parts[i].startsWith("-") &&
      parts[i].length === 2 &&
      /[a-zA-Z]/.test(parts[i][1])
    ) {
      flags.add(parts[i][1].toLowerCase());
    } else {
      argParts.push(parts[i]);
    }
  }

  return {
    name,
    args: argParts.join(" "),
    rawArgs: argParts,
    flags,
  };
}

export function isAdminCommand(commandName: string): boolean {
  return ADMIN_COMMANDS.has(commandName);
}
