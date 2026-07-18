export interface ParsedCommand {
  name: string;
  args: string;
  rawArgs: string[];
  flags: Set<string>;
}

/** How a command reaches its implementation. */
export type CommandKind =
  | "resolved" // register-handlers: LocalProvider.resolve-first music commands
  | "delegated" // register-handlers: delegates to BotInstance.executeCommand
  | "special" // register-handlers: service-backed (roast/memory/kg/knowledge)
  | "router"; // handled inside ControlRouter itself (LLM/workflow intents)

/** Voice pipeline scope (future middleware / voice policy). */
export type VoiceScope = "none" | "listen" | "speak" | "full";

export interface CommandSpec {
  name: string;
  kind: CommandKind;
  /** Legacy admin tier (rights default build + gating). Absent = public. */
  admin?: boolean;
  /** Requires a live TeamSpeak connection (router + executor guard). */
  audio?: boolean;
  /**
   * Rights token when different from `name` (e.g. radio.power).
   * Optional metadata for CommandRegistry / MCP; gating may still use name.
   */
  rightsToken?: string;
  /** Optional voice policy metadata (PR-A1+). */
  voiceScope?: VoiceScope;
  /**
   * LLM tool name that maps to this command (default: name).
   * Used by CommandRegistry.toolToCommand; toolCallToCommand still has special cases.
   */
  llmTool?: string;
  /** Human description for MCP / docs generation. */
  description?: string;
}

/**
 * THE single source of truth for typed commands. Every derived surface —
 * PUBLIC/ADMIN sets, the audio guard, register-handlers' lists — is generated
 * from this table, and tests assert the rights template stays aligned. Adding
 * a command = one entry here + a `case` in CommandExecutor (or a special
 * runner) — nothing else. (Previously a name lived in up to six hand-kept
 * lists; `!chevron7` and `!playnext` both broke from exactly that drift.)
 */
export const COMMAND_MANIFEST: readonly CommandSpec[] = [
  // Music — resolve local first, then fall through to executeCommand.
  // llmTool aliases match LLM tool-call names (PR-A2 metadata; toolCallToCommand still owns specials).
  { name: "play", kind: "resolved", audio: true, llmTool: "play_music" },
  { name: "add", kind: "resolved", audio: true, llmTool: "queue" },
  { name: "playnext", kind: "resolved", audio: true },
  { name: "pn", kind: "resolved", audio: true },
  { name: "playlist", kind: "resolved", audio: true },
  { name: "album", kind: "resolved", audio: true },
  // Transport + queue (delegated to the executor switch).
  { name: "skip", kind: "delegated", audio: true, llmTool: "skip" },
  { name: "next", kind: "delegated", audio: true },
  { name: "prev", kind: "delegated", audio: true },
  { name: "pause", kind: "delegated", llmTool: "pause" },
  { name: "resume", kind: "delegated", llmTool: "resume" },
  { name: "stop", kind: "delegated", admin: true, llmTool: "stop" },
  { name: "clear", kind: "delegated", admin: true },
  { name: "vol", kind: "delegated", admin: true, llmTool: "set_volume" },
  { name: "remove", kind: "delegated", admin: true },
  { name: "mode", kind: "delegated", admin: true },
  // Playback ban list (search / auto-DJ / resolve) — DJ/admin; !ban = current track + skip.
  { name: "ban", kind: "delegated", admin: true },
  { name: "unban", kind: "delegated", admin: true },
  { name: "now", kind: "delegated", llmTool: "now_playing" },
  { name: "queue", kind: "delegated" },
  { name: "list", kind: "delegated" },
  { name: "artist", kind: "delegated", audio: true },
  { name: "test", kind: "delegated", audio: true },
  { name: "lyrics", kind: "delegated" },
  { name: "vote", kind: "delegated" },
  { name: "help", kind: "delegated" },
  { name: "chevron7", kind: "delegated", audio: true }, // easter egg: dials the SG-1 theme
  // Radio / DJ (docs/radio.md §12; sensitive subcommands carry radio.* tokens).
  { name: "radio", kind: "delegated" },
  { name: "rate", kind: "delegated" },
  { name: "unrate", kind: "delegated" },
  {
    name: "selecttracks",
    kind: "delegated",
    llmTool: "select_tracks",
    description: "Tag/BPM/rating selection; LLM tool select_tracks",
  },
  // Channel admin.
  { name: "move", kind: "delegated", admin: true },
  { name: "moveclient", kind: "delegated", admin: true, llmTool: "move_client" },
  { name: "moveall", kind: "delegated", admin: true, llmTool: "move_all_clients" },
  { name: "follow", kind: "delegated", admin: true },
  // Community / knowledge (service-backed runners in register-handlers).
  { name: "roast", kind: "special" },
  { name: "roastout", kind: "special" },
  { name: "roastin", kind: "special" },
  { name: "remember", kind: "special" },
  { name: "recall", kind: "special" },
  { name: "forget", kind: "special" },
  { name: "kg", kind: "special" },
  { name: "diary", kind: "special" },
  // Personal hangar + org rollup (ships.org = Colonel/Chairman).
  { name: "ships", kind: "special" },
  { name: "hangar", kind: "special" },
  // Org/ops brief + external status plugins (feature-roadmap G1/G2).
  { name: "ops", kind: "special" },
  // G4 moderation (rights-gated; fail-open on transport).
  { name: "mute", kind: "special", admin: true },
  { name: "kick", kind: "special", admin: true },
  // Org economy orders (docs/economy.md) — seed + UEX + sc-craft + sc-trade.
  { name: "mine", kind: "special" },
  { name: "refine", kind: "special" },
  { name: "craft", kind: "special" },
  { name: "econ", kind: "special" },
  { name: "trade", kind: "special" },
  // Org work-order shopping list (aggregate materials).
  { name: "workorder", kind: "special" },
  { name: "work-items", kind: "special" },
  { name: "workitems", kind: "special" },
  { name: "reindex", kind: "special", admin: true },
  { name: "ingeststatus", kind: "special", admin: true },
  // ACE-Step music gen (docs/ace-step.md) — @dj / admin via rights, not public.
  { name: "generate", kind: "special", audio: true },
  // LLM / workflow intents routed inside ControlRouter.
  { name: "ask", kind: "router" },
  { name: "analyst", kind: "router" },
  { name: "agent", kind: "router" },
  { name: "intsum", kind: "router" },
  { name: "aar", kind: "router" },
];

/** Rights tokens that are gated but not typed commands themselves. */
const ADMIN_TOKENS = ["radio.power", "workorder.clear", "ships.org"] as const;

export const PUBLIC_COMMANDS = new Set(COMMAND_MANIFEST.filter((c) => !c.admin).map((c) => c.name));

export const ADMIN_COMMANDS = new Set([
  ...COMMAND_MANIFEST.filter((c) => c.admin).map((c) => c.name),
  ...ADMIN_TOKENS,
]);

/** Commands that require a live TS connection (router + executor guard). */
export const AUDIO_COMMANDS = new Set(COMMAND_MANIFEST.filter((c) => c.audio).map((c) => c.name));

/** Names of a given kind, for register-handlers' generated lists. */
export function commandsOfKind(kind: CommandKind): string[] {
  return COMMAND_MANIFEST.filter((c) => c.kind === kind).map((c) => c.name);
}

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
    if (parts[i].startsWith("-") && parts[i].length === 2 && /[a-zA-Z]/.test(parts[i][1])) {
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
