/**
 * LLM tool call → ParsedCommand mapping (PR-A3).
 *
 * Replaces the switch in router.ts. Special multi-arg / semantic tools are
 * registered as mappers; simple 1:1 aliases come from COMMAND_MANIFEST.llmTool.
 */
import { COMMAND_MANIFEST, type ParsedCommand } from "../bot/commands.js";

export type ToolCallInput = {
  name: string;
  arguments?: Record<string, unknown>;
};

export type ToolMapper = (args: Record<string, unknown>) => ParsedCommand | null;

/** Map source preference from play_music/queue tools to a provider flag. */
export function sourceFlags(source?: string): Set<string> {
  const flags = new Set<string>();
  if (source === "youtube") flags.add("y");
  else if (source === "local") flags.add("l");
  else if (source === "stream") flags.add("s");
  // "auto" / undefined → no flag → BotInstance defaults to Local (primary).
  return flags;
}

function make(name: string, args = "", flags?: Set<string>): ParsedCommand {
  return {
    name,
    args,
    rawArgs: args ? args.split(/\s+/).filter(Boolean) : [],
    flags: flags ?? new Set<string>(),
  };
}

/** Built-in multi-arg / semantic mappers (not expressible as plain llmTool aliases). */
export const SPECIAL_TOOL_MAPPERS: Record<string, ToolMapper> = {
  play_music: (a) => {
    const query = String(a.query ?? "").trim();
    if (!query) return null;
    return {
      ...make("play", query),
      flags: sourceFlags(typeof a.source === "string" ? a.source : undefined),
    };
  },
  queue: (a) => {
    const query = String(a.query ?? "").trim();
    if (!query) return null;
    // §9 queue(query) = add to the end of the queue without interrupting.
    return make("add", query);
  },
  select_tracks: (a) => {
    // Gemma on NPU often picks select_tracks for plain "play jazz" — map a lone
    // genre to play so we search/resolve instead of tag-only selection.
    const genres = a.genreAny;
    if (
      Array.isArray(genres) &&
      genres.length === 1 &&
      typeof genres[0] === "string" &&
      !a.mood &&
      !a.bpmMin &&
      !a.bpmMax &&
      !a.ratingMin
    ) {
      const q = genres[0].replace(/^\[|\]$/g, "").trim();
      if (q) return make("play", q);
    }
    return make("selecttracks", JSON.stringify(a));
  },
  set_volume: (a) => {
    const level = Number(a.level);
    if (!Number.isFinite(level)) return null;
    return make("vol", String(Math.round(level)));
  },
  move_client: (a) => {
    const client = String(a.client ?? a.target ?? "").trim();
    const channel = String(a.channel ?? "").trim();
    if (!client || !channel) return null;
    return {
      name: "moveclient",
      args: `${client} ${channel}`,
      rawArgs: [client, channel],
      flags: new Set<string>(),
    };
  },
  move_all_clients: (a) => {
    const channel = String(a.channel ?? "").trim();
    if (!channel) return null;
    return make("moveall", channel);
  },
};

/**
 * Simple tool name → command name from manifest `llmTool` fields, for tools
 * that only need empty args or a single query string.
 */
export function simpleToolAliasMap(
  specs: readonly { name: string; llmTool?: string }[] = COMMAND_MANIFEST,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of specs) {
    m.set(s.name, s.name);
    if (s.llmTool) m.set(s.llmTool, s.name);
  }
  return m;
}

/**
 * Translate an LLM music-control tool call into a synthetic ParsedCommand so it
 * can run through the deterministic router exactly like a typed `!`-command.
 * Returns null for tools we don't recognize.
 */
export function toolCallToCommand(tc: ToolCallInput): ParsedCommand | null {
  const name = tc.name;
  const a = tc.arguments ?? {};

  const special = SPECIAL_TOOL_MAPPERS[name];
  if (special) return special(a);

  // Simple aliases: skip, pause, resume, stop, now_playing, etc.
  const aliases = simpleToolAliasMap();
  const cmdName = aliases.get(name);
  if (!cmdName) return null;

  // Tools that are pure aliases with no required args
  if (
    name === "skip" ||
    name === "pause" ||
    name === "resume" ||
    name === "stop" ||
    name === "now_playing" ||
    cmdName === name
  ) {
    // now_playing / skip / etc. — empty args
    if (
      name === "now_playing" ||
      name === "skip" ||
      name === "pause" ||
      name === "resume" ||
      name === "stop"
    ) {
      return make(cmdName);
    }
  }

  // Generic: optional query/target/prompt as args string + platform flags
  const q =
    typeof a.query === "string"
      ? a.query.trim()
      : typeof a.target === "string"
        ? a.target.trim()
        : typeof a.prompt === "string"
          ? a.prompt.trim()
          : "";
  const flags = sourceFlags(
    typeof a.source === "string"
      ? a.source
      : typeof a.platform === "string"
        ? a.platform
        : undefined,
  );
  return make(cmdName, q, flags);
}

/** Tool names with a mapper or alias (for tests / MCP alignment). */
export function knownLlmToolNames(): string[] {
  const names = new Set<string>(Object.keys(SPECIAL_TOOL_MAPPERS));
  for (const s of COMMAND_MANIFEST) {
    names.add(s.name);
    if (s.llmTool) names.add(s.llmTool);
  }
  return [...names].sort();
}
