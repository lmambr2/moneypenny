import { parseCommand, isKnownCommand, type ParsedCommand } from "../bot/commands.js";
import type { BotInstance } from "../bot/instance.js";
import type { Logger } from "../logger.js";

/**
 * CommandHandler - registered handlers that the router can delegate execution to.
 * This allows us to gradually move logic out of the giant switch in BotInstance.
 */
export interface CommandHandler {
  name: string;
  execute(cmd: ParsedCommand, context: RouterContext, decision: RouterDecision): Promise<string | null>;
}

/**
 * Minimal LLM seam the router depends on (DESIGN §9). The concrete LlmModule in
 * bot/src/llm/ implements this; tests can pass a lightweight fake. Keeping the
 * router coupled only to this interface keeps the deterministic path free of
 * any hard dependency on the network client.
 */
export interface LlmAssist {
  /** Plain-text Q&A for `!ask <question>` (no tools). */
  ask(question: string, conversationId?: string): Promise<string>;
  /** Fuzzy music intent — may return tool calls to drive playback. */
  chatForIntent(userMessage: string, conversationId?: string): Promise<{
    content: string | null;
    toolCalls?: Array<{ name: string; arguments: any }>;
  }>;
}

/**
 * ControlRouter
 *
 * This is the central decision layer described in DESIGN.md §4.
 *
 * Flow:
 * 1. Deterministic commands first (fast, reliable, no LLM cost)
 * 2. `!ask <q>` → LLM text Q&A
 * 3. A prefixed input whose name is NOT a known command → LLM tool-calling for
 *    fuzzy music intent; resolved tool calls run through the SAME deterministic
 *    resolve+execute path (no IPC, shared typed state — DESIGN §9)
 *
 * The router owns the policy: "never put the model between a user and the skip button."
 */

export interface RouterContext {
  bot: BotInstance;
  logger: Logger;
  // Stable key scoping LLM conversation history (DESIGN §9). Set by the caller
  // from the inbound message (e.g. per-channel or per-user). Undefined → the
  // LLM call is stateless.
  conversationId?: string;
  // Rank-gating check (DESIGN §8). Returns whether the invoker may run the
  // named command. Undefined → no gating (rights disabled). Applied to BOTH
  // typed commands and LLM-tool-derived commands so natural language can't
  // escalate privileges.
  canRun?: (commandName: string) => boolean;
}

export interface LlmIntent {
  mode: "ask" | "intent";
  /** The question (ask) or the fuzzy natural-language text (intent). */
  text: string;
}

export interface RouterDecision {
  type: "deterministic" | "llm" | "unknown";
  command?: ParsedCommand;
  // When the router (or future LLM) pre-resolves a music item using LocalProvider.resolve
  resolvedMusic?: {
    type: 'song' | 'playlist';
    item: any; // Song or Playlist
    providerPlatform: 'local' | 'youtube' | 'stream';
  };
  // Present when type === "llm": what to hand to the LLM module.
  llmIntent?: LlmIntent;
}

/** Music commands that benefit from an early LocalProvider.resolve (DESIGN §7.4 + §4). */
const RESOLVABLE_MUSIC_COMMANDS = new Set(['play', 'add', 'playnext', 'pn', 'playlist', 'album']);

/** Commands that push audio and therefore require an active TS connection. */
const AUDIO_COMMANDS = new Set([
  "play", "add", "playnext", "pn", "next", "skip", "prev",
  "playlist", "album", "fm", "artist",
]);

export class ControlRouter {
  private logger: Logger;
  private handlers = new Map<string, CommandHandler>();
  private llm?: LlmAssist;

  constructor(logger: Logger, llm?: LlmAssist) {
    this.logger = logger.child({ component: "control-router" });
    this.llm = llm;
  }

  /** Attach (or replace) the LLM module after construction. */
  setLlm(llm: LlmAssist | undefined) {
    this.llm = llm;
  }

  /** Whether an LLM module is wired (used for help text / status). */
  hasLlm(): boolean {
    return !!this.llm;
  }

  /** Register a handler for a specific command name. */
  registerHandler(handler: CommandHandler) {
    this.handlers.set(handler.name.toLowerCase(), handler);
  }

  /**
   * Main entry point for all user text input (chat commands + future transcribed voice).
   */
  async route(
    input: string,
    context: RouterContext,
    commandPrefix: string = "!",
    aliases: Record<string, string> = {},
  ): Promise<RouterDecision> {
    const trimmed = input.trim();
    if (!trimmed) {
      return { type: "unknown" };
    }

    const command = parseCommand(trimmed, commandPrefix, aliases);

    // Non-prefixed chat is intentionally ignored — fuzzy intent must opt in via
    // the command prefix so the bot never responds to ordinary conversation.
    if (!command) {
      return { type: "unknown" };
    }

    // `!ask <question>` → LLM Q&A path (no tools).
    if (command.name === "ask") {
      return { type: "llm", llmIntent: { mode: "ask", text: command.args } };
    }

    // Known command → deterministic dispatch (the fast, reliable path).
    if (isKnownCommand(command.name)) {
      this.logger.debug({ command: command.name }, "Deterministic command matched");
      const resolvedMusic = await this.resolveMusicForCommand(command, context);
      return { type: "deterministic", command, resolvedMusic };
    }

    // Prefixed but not a recognized command → fuzzy music intent for the LLM.
    // Strip the prefix so the model sees natural language, not "!something".
    this.logger.debug({ command: command.name }, "Unrecognized command — routing to LLM intent");
    return {
      type: "llm",
      llmIntent: { mode: "intent", text: trimmed.slice(commandPrefix.length).trim() },
    };
  }

  /**
   * Route a transcribed voice utterance (DESIGN §10). Same policy as chat but
   * WITHOUT a command prefix: if the first word is a known command, dispatch it
   * deterministically (so spoken "skip"/"pause" never touch the model); else
   * hand the whole utterance to the LLM intent path — which both drives fuzzy
   * music control (tool calls) and answers spoken questions (plain content).
   * The returned decision flows through the same execute() path, so rank gating
   * and the audio guard apply identically to voice.
   */
  async routeVoice(
    transcript: string,
    context: RouterContext,
    aliases: Record<string, string> = {},
  ): Promise<RouterDecision> {
    const text = transcript.trim();
    if (!text) return { type: "unknown" };

    // Parse as if prefixed so flag/alias handling is shared with the chat path.
    const command = parseCommand("!" + text, "!", aliases);
    if (command && isKnownCommand(command.name)) {
      this.logger.debug({ command: command.name }, "Voice: deterministic command matched");
      const resolvedMusic = await this.resolveMusicForCommand(command, context);
      return { type: "deterministic", command, resolvedMusic };
    }

    this.logger.debug("Voice: routing to LLM intent");
    return { type: "llm", llmIntent: { mode: "intent", text } };
  }

  /**
   * Attempt a high-certainty LocalProvider.resolve for music commands.
   * Shared by the deterministic path and the LLM tool-call path so both drive
   * the primary local source identically.
   */
  private async resolveMusicForCommand(
    command: ParsedCommand,
    context: RouterContext,
  ): Promise<RouterDecision['resolvedMusic']> {
    if (!RESOLVABLE_MUSIC_COMMANDS.has(command.name) || !command.args) {
      return undefined;
    }
    try {
      const localProvider = (context.bot as any).localProvider;
      if (localProvider?.resolve) {
        const resolved = await localProvider.resolve(command.args);
        if (resolved) {
          this.logger.debug({ command: command.name, resolvedType: resolved.type }, "Local resolve succeeded in router");
          return { type: resolved.type, item: resolved.item, providerPlatform: 'local' };
        }
      }
    } catch (e) {
      this.logger.debug({ err: e }, "Local resolve in router failed, will fall back");
    }
    return undefined;
  }

  /**
   * Execute a decision. This is where we call into BotInstance methods.
   * Keeping execution separate from decision making makes testing and LLM integration cleaner.
   */
  async execute(decision: RouterDecision, context: RouterContext): Promise<string | null> {
    if (decision.type === "deterministic" && decision.command) {
      return this.executeDeterministic(decision, context);
    }

    if (decision.type === "llm" && decision.llmIntent) {
      return this.executeLlm(decision.llmIntent, context);
    }

    return null;
  }

  /** Run a resolved deterministic decision through its registered handler. */
  private async executeDeterministic(decision: RouterDecision, context: RouterContext): Promise<string | null> {
    const cmd = decision.command!;

    // Rank gating (DESIGN §8) — the first gate. Applies to typed commands and
    // LLM-tool-derived commands alike (both reach here), so natural language
    // cannot escalate past the invoker's rank.
    if (context.canRun && !context.canRun(cmd.name)) {
      this.logger.debug({ command: cmd.name }, "Command denied by rights");
      return `You don't have permission to use '${cmd.name}'.`;
    }

    // Centralized audio command guard (owned by the router)
    if (!context.bot.isConnected() && AUDIO_COMMANDS.has(cmd.name)) {
      return "Bot is not connected to TeamSpeak";
    }

    const handler = this.handlers.get(cmd.name.toLowerCase());

    if (handler) {
      this.logger.debug({ command: cmd.name }, "Executing via registered handler");
      return handler.execute(cmd, context, decision);
    }

    // No handler — the router is now expected to handle all normal commands.
    // This path should only be hit for truly unknown or admin-only commands during transition.
    this.logger.warn({ command: cmd.name }, "No handler registered for command in ControlRouter");
    return `Command '${cmd.name}' is not yet fully implemented in the new router system.`;
  }

  /** Handle the LLM decision: Q&A for `ask`, tool-driven control for `intent`. */
  private async executeLlm(intent: LlmIntent, context: RouterContext): Promise<string | null> {
    if (!this.llm) {
      // No LLM wired. For an explicit `!ask` we say so; for unrecognized
      // prefixed input we surface the old "unknown command" message.
      if (intent.mode === "ask") {
        return "The local LLM is not configured. Ask an admin to enable it.";
      }
      return `Unknown command. Try ${"!"}help.`;
    }

    if (intent.mode === "ask") {
      if (context.canRun && !context.canRun("ask")) {
        return "You don't have permission to use 'ask'.";
      }
      if (!intent.text) return "Usage: !ask <question>";
      return this.llm.ask(intent.text, context.conversationId);
    }

    // mode === "intent": fuzzy music control via tool-calling.
    return this.executeIntent(intent.text, context);
  }

  /**
   * Ask the LLM to interpret fuzzy text, then execute any music tool calls by
   * mapping them to deterministic commands and running them through the SAME
   * resolve+execute path the `!`-commands use (DESIGN §9 — shared executors).
   */
  private async executeIntent(text: string, context: RouterContext): Promise<string | null> {
    if (!text) return null;

    const result = await this.llm!.chatForIntent(text, context.conversationId);
    const toolCalls = result.toolCalls ?? [];

    if (toolCalls.length === 0) {
      // No actionable intent — return the model's plain answer if any.
      return result.content;
    }

    const outputs: string[] = [];
    for (const tc of toolCalls) {
      const cmd = toolCallToCommand(tc);
      if (!cmd) {
        this.logger.warn({ tool: tc.name }, "LLM emitted an unknown/unmapped tool call");
        continue;
      }
      try {
        const resolvedMusic = await this.resolveMusicForCommand(cmd, context);
        const out = await this.executeDeterministic({ type: "deterministic", command: cmd, resolvedMusic }, context);
        if (out) outputs.push(out);
      } catch (err) {
        this.logger.warn({ err, tool: tc.name }, "LLM tool execution failed");
        outputs.push(`Couldn't ${tc.name.replace(/_/g, " ")} right now.`);
      }
    }

    if (outputs.length > 0) return outputs.join("\n");
    // Tools fired but produced no message — fall back to any model text.
    return result.content;
  }
}

/** Map source preference from the play_music/queue tools to a provider flag. */
function sourceFlags(source?: string): Set<string> {
  const flags = new Set<string>();
  if (source === "youtube") flags.add("y");
  else if (source === "local") flags.add("l");
  // "auto" / undefined → no flag → BotInstance defaults to Local (primary).
  return flags;
}

/**
 * Translate an LLM music-control tool call into a synthetic ParsedCommand so it
 * can run through the deterministic router exactly like a typed `!`-command.
 * Returns null for tools we don't recognize.
 */
export function toolCallToCommand(tc: { name: string; arguments: any }): ParsedCommand | null {
  const a = tc.arguments ?? {};
  const make = (name: string, args = ""): ParsedCommand => ({
    name,
    args,
    rawArgs: args ? args.split(/\s+/) : [],
    flags: new Set<string>(),
  });

  switch (tc.name) {
    case "play_music": {
      const query = String(a.query ?? "").trim();
      if (!query) return null;
      return { ...make("play", query), flags: sourceFlags(a.source) };
    }
    case "queue": {
      const query = String(a.query ?? "").trim();
      if (!query) return null;
      // §9 queue(query) = add to the end of the queue without interrupting.
      return make("add", query);
    }
    case "skip":
      return make("skip");
    case "pause":
      return make("pause");
    case "resume":
      return make("resume");
    case "stop":
      return make("stop");
    case "set_volume": {
      const level = Number(a.level);
      if (!Number.isFinite(level)) return null;
      return make("vol", String(Math.round(level)));
    }
    case "now_playing":
      return make("now");
    default:
      return null;
  }
}
