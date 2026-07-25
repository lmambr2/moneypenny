import type { TS3TextMessage } from "@moneypenny/ts6-client";
import { isKnownCommand, type ParsedCommand, parseCommand } from "../bot/commands.js";
import type { BotInstance } from "../bot/instance.js";
import type { WorkflowKind, WorkflowRequest } from "../docs/workflow.js";
import type { Logger } from "../logger.js";
import type { Playlist, Song } from "../music/provider.js";
import { type ClarifyService, MemoryClarifyService } from "./clarify-service.js";
import { applyDeterministicGates } from "./deterministic-gates.js";
import { executeLlmPath, llmUnavailableMessage } from "./llm-path.js";
import { CommandRegistry } from "./registry.js";

export { type ClarifyService, MemoryClarifyService } from "./clarify-service.js";
export { knownLlmToolNames, sourceFlags, toolCallToCommand } from "./tool-map.js";

/**
 * CommandHandler — registered handlers the router delegates to after routing.
 * Implementations live in register-handlers.ts and BotInstance subsystem delegates.
 */
export interface CommandHandler {
  name: string;
  execute(
    cmd: ParsedCommand,
    context: RouterContext,
    decision: RouterDecision,
  ): Promise<string | null>;
}

/**
 * Minimal LLM seam the router depends on (DESIGN §9). The concrete LlmModule in
 * bot/src/llm/ implements this; tests can pass a lightweight fake. Keeping the
 * router coupled only to this interface keeps the deterministic path free of
 * any hard dependency on the network client.
 */
export interface LlmAssist {
  /** Plain-text Q&A for `!ask <question>` (no tools). ctx carries rank-gating + memory scope. */
  ask(
    question: string,
    conversationId?: string,
    ctx?: { allowedClassifications?: string[]; userUid?: string },
  ): Promise<string>;
  /** Fuzzy music intent — may return tool calls to drive playback. */
  chatForIntent(
    userMessage: string,
    conversationId?: string,
    opts?: { moveClientEnabled?: boolean },
  ): Promise<{
    content: string | null;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  }>;
  /** Heavy analysis via the delegate endpoint (DESIGN §R1). */
  delegate(
    task: string,
    extraContext?: string,
    ctx?: { allowedClassifications?: string[]; userUid?: string },
  ): Promise<string>;
  /** Whether a delegate endpoint is configured (skip async ack when false). */
  isDelegateConfigured?(): boolean;
  /** DESIGN §R3 — templated INTSUM / AAR generation via the delegate model. */
  generateWorkflowDoc?(
    req: WorkflowRequest,
    ctx?: { allowedClassifications?: string[]; userUid?: string },
  ): Promise<string>;
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
  // Invoker identity for handlers that must act per-user (e.g. the roast
  // opt-out/purge). The registered-handler signature only gets (cmd, ctx,
  // decision), so the uid/name ride along on the context. Undefined for
  // synthetic/internal calls with no human invoker.
  invokerUid?: string;
  invokerName?: string;
  /** Original TS message when routing chat input — needed for vote/follow. */
  message?: TS3TextMessage;
  /**
   * Post a follow-up message to the channel (DESIGN §R1b). When set, delegate
   * work runs in the background and the router returns DELEGATE_ACK_MESSAGE
   * immediately instead of blocking on the heavy model.
   */
  postFollowUp?: (text: string) => Promise<void>;
  // Doctrine classifications the invoker is cleared to retrieve (Phase 6
  // rank-gating). Built from the rights engine; passed into `!ask` so classified
  // chunks are filtered out for unauthorized members.
  allowedClassifications?: string[];
}

/** Structured invoker identity for router logs (text chat / web context). */
export function invokerFields(context: RouterContext): Record<string, string | number> {
  const fields: Record<string, string | number> = {};
  if (context.invokerName) fields.invokerName = context.invokerName;
  if (context.invokerUid) fields.invokerUid = context.invokerUid;
  const clid = context.message?.invokerId;
  if (clid) {
    const n = Number.parseInt(clid, 10);
    if (Number.isFinite(n)) fields.invokerClientId = n;
  }
  return fields;
}

/** Commands we always log at info so queue/play issues are greppable in prod. */
const MUSIC_COMMAND_LOG = new Set([
  "play",
  "add",
  "playnext",
  "pn",
  "playlist",
  "album",
  "artist",
  "skip",
  "next",
  "jump",
  "go",
  "prev",
  "stop",
  "clear",
  "remove",
  "mode",
  "test",
  "vote",
  "chevron7",
  "radio",
]);

function musicCommandSurface(context: RouterContext): "web" | "teamspeak" | "voice" | "unknown" {
  if (context.conversationId?.startsWith("web:")) return "web";
  if (context.message) return "teamspeak";
  // Voice path often has invoker but no TS3TextMessage.
  if (context.invokerUid || context.invokerName) return "voice";
  return "unknown";
}

/**
 * Classify a music-command reply for ops logs (not security).
 * Grep: `Music command` in bot logs.
 */
export function classifyMusicCommandResult(message: string | null | undefined): {
  denied: boolean;
  ok: boolean;
  reason: string;
} {
  const msg = (message ?? "").trim();
  if (!msg) return { denied: false, ok: false, reason: "empty" };
  if (msg.startsWith("You don't have permission") || msg.includes("needs '")) {
    return { denied: true, ok: false, reason: "permission" };
  }
  if (msg.includes("Only Chairman or server admin")) {
    return { denied: true, ok: false, reason: "demo_protect" };
  }
  if (msg.startsWith("Bot is not connected")) {
    return { denied: false, ok: false, reason: "disconnected" };
  }
  if (msg.startsWith("No results") || msg.startsWith("No results found")) {
    return { denied: false, ok: false, reason: "noresults" };
  }
  if (msg.startsWith("Cannot play") || msg.startsWith("Cannot play:")) {
    return { denied: false, ok: false, reason: "cantplay" };
  }
  if (msg.startsWith("Usage:") || msg.startsWith("Unknown command")) {
    return { denied: false, ok: false, reason: "usage" };
  }
  if (msg.startsWith("Blocked") || msg.includes("Blocked by station")) {
    return { denied: false, ok: false, reason: "policy" };
  }
  if (
    msg.startsWith("Now playing") ||
    msg.startsWith("Added") ||
    msg.startsWith("Up next") ||
    msg.startsWith("Playing") ||
    msg.startsWith("Paused") ||
    msg.startsWith("Resumed") ||
    msg.startsWith("Stopped") ||
    msg.startsWith("Queue") ||
    msg.startsWith("Skipped") ||
    msg.includes("cleared") ||
    msg.includes("Volume set")
  ) {
    return { denied: false, ok: true, reason: "ok" };
  }
  // Default: treat non-empty reply as success (status/help-like).
  return { denied: false, ok: true, reason: "ok" };
}

function logMusicCommand(
  logger: Logger,
  cmd: ParsedCommand,
  context: RouterContext,
  message: string | null,
): void {
  if (!MUSIC_COMMAND_LOG.has(cmd.name.toLowerCase())) return;
  const { denied, ok, reason } = classifyMusicCommandResult(message);
  logger.info(
    {
      command: cmd.name,
      args: (cmd.args ?? "").slice(0, 160),
      flags: [...cmd.flags],
      surface: musicCommandSurface(context),
      denied,
      ok,
      reason,
      result: (message ?? "").slice(0, 220) || null,
      ...invokerFields(context),
    },
    "Music command",
  );
}

export interface LlmIntent {
  mode: "ask" | "intent" | "delegate" | "workflow";
  /** The question (ask), fuzzy NL (intent), or analyst task (delegate). */
  text: string;
  /** Present when mode === "workflow". */
  workflowKind?: WorkflowKind;
  workflowFlags?: Set<string>;
  /** Present when mode === "delegate" (`!analyst` / `!agent`). */
  delegateFlags?: Set<string>;
}

export interface RouterDecision {
  type: "deterministic" | "llm" | "unknown";
  command?: ParsedCommand;
  // When the router (or future LLM) pre-resolves a music item using LocalProvider.resolve
  resolvedMusic?: {
    type: "song" | "playlist";
    item: Song | Playlist;
    providerPlatform: "local" | "youtube" | "stream";
  };
  // Present when type === "llm": what to hand to the LLM module.
  llmIntent?: LlmIntent;
}

/** Music commands that benefit from an early LocalProvider.resolve (DESIGN §7.4 + §4). */
const RESOLVABLE_MUSIC_COMMANDS = new Set(["play", "add", "playnext", "pn", "playlist", "album"]);

/** Commands that push audio and therefore require an active TS connection. */
// Audio-gated commands come from the single manifest (bot/commands.ts).

/** Strip STT punctuation so "Pause." / "Skip?" still match deterministic commands. */
export function normalizeVoiceTranscript(transcript: string): string {
  return transcript
    .trim()
    .replace(/[.!?,;:]+$/u, "")
    .trim();
}

export class ControlRouter {
  private logger: Logger;
  /** PR-A1+: handlers + middleware pipeline. */
  private readonly registry = new CommandRegistry();
  private llm?: LlmAssist;
  /** PR-A4: injectable clarify-once (default in-memory). */
  private clarify: ClarifyService;

  constructor(logger: Logger, llm?: LlmAssist, clarify?: ClarifyService) {
    this.logger = logger.child({ component: "control-router" });
    this.llm = llm;
    this.clarify = clarify ?? new MemoryClarifyService();
  }

  /** Attach (or replace) the LLM module after construction. */
  setLlm(llm: LlmAssist | undefined) {
    this.llm = llm;
  }

  setClarifyOnceEnabled(enabled: boolean): void {
    this.clarify.setEnabled(enabled);
  }

  /** Whether an LLM module is wired (used for help text / status). */
  hasLlm(): boolean {
    return !!this.llm;
  }

  /** Command registry (handlers + optional middleware). */
  getRegistry(): CommandRegistry {
    return this.registry;
  }

  /** Register a handler for a specific command name. */
  registerHandler(handler: CommandHandler) {
    this.registry.register(handler);
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

    // `!analyst` / `!agent` → heavy delegate path (DESIGN §R1).
    if (command.name === "analyst" || command.name === "agent") {
      return {
        type: "llm",
        llmIntent: { mode: "delegate", text: command.args, delegateFlags: command.flags },
      };
    }

    // `!intsum` / `!aar` → templated org docs (DESIGN §R3).
    if (command.name === "intsum" || command.name === "aar") {
      return {
        type: "llm",
        llmIntent: {
          mode: "workflow",
          text: command.args,
          workflowKind: command.name,
          workflowFlags: command.flags,
        },
      };
    }

    // Known command → deterministic dispatch (the fast, reliable path).
    if (isKnownCommand(command.name)) {
      this.logger.debug(
        { command: command.name, ...invokerFields(context) },
        "Deterministic command matched",
      );
      const resolvedMusic = await this.resolveMusicForCommand(command, context);
      return { type: "deterministic", command, resolvedMusic };
    }

    // Prefixed but not a recognized command → fuzzy music intent for the LLM.
    // Strip the prefix so the model sees natural language, not "!something".
    this.logger.debug(
      { command: command.name, ...invokerFields(context) },
      "Unrecognized command — routing to LLM intent",
    );
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
    const text = normalizeVoiceTranscript(transcript);
    if (!text) return { type: "unknown" };

    // Parse as if prefixed so flag/alias handling is shared with the chat path.
    const command = parseCommand(`!${text}`, "!", aliases);
    if (command) {
      command.name = command.name.replace(/[.,!?;:]+$/u, "");
    }
    if (command && isKnownCommand(command.name)) {
      // STT often hears "play" without the title on a partial route — fall back
      // to the LLM so "play bohemian rhapsody" isn't executed as bare !play.
      if (command.name === "play" && !command.args?.trim()) {
        this.logger.debug({ transcript: text }, "Voice: bare play verb — routing to LLM intent");
        return { type: "llm", llmIntent: { mode: "intent", text } };
      }
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
  ): Promise<RouterDecision["resolvedMusic"]> {
    if (!RESOLVABLE_MUSIC_COMMANDS.has(command.name) || !command.args) {
      return undefined;
    }
    try {
      const resolved = await context.bot.resolveLocalMusic(command.args);
      if (resolved) {
        this.logger.debug(
          { command: command.name, resolvedType: resolved.type, ...invokerFields(context) },
          "Local resolve succeeded in router",
        );
        return { type: resolved.type, item: resolved.item, providerPlatform: "local" };
      }
    } catch (e) {
      this.logger.debug({ err: e }, "Local resolve in router failed, will fall back");
    }
    return undefined;
  }

  /**
   * Run a pre-parsed deterministic command through resolve + handler dispatch.
   * Used by the web Player API so HTTP and TS chat share rank gating and handlers.
   */
  async executeParsedCommand(cmd: ParsedCommand, context: RouterContext): Promise<string | null> {
    const resolvedMusic = await this.resolveMusicForCommand(cmd, context);
    return this.executeDeterministic(
      { type: "deterministic", command: cmd, resolvedMusic },
      context,
    );
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

  /** Run a resolved deterministic decision through gates + CommandRegistry. */
  private async executeDeterministic(
    decision: RouterDecision,
    context: RouterContext,
  ): Promise<string | null> {
    const cmd = decision.command!;
    let result: string | null = null;

    try {
      const denied = applyDeterministicGates(cmd, context, this.logger);
      if (denied != null) {
        result = denied;
        return result;
      }

      if (this.registry.has(cmd.name)) {
        this.logger.debug(
          { command: cmd.name, ...invokerFields(context) },
          "Executing via CommandRegistry",
        );
        result = await this.registry.execute(cmd, context, decision);
        return result;
      }

      this.logger.warn({ command: cmd.name }, "No handler registered for command in ControlRouter");
      result = `Unknown command. Try ${"!"}help.`;
      return result;
    } finally {
      logMusicCommand(this.logger, cmd, context, result);
    }
  }

  /** LLM path: ask / intent / delegate / workflow (llm-path.ts). */
  private async executeLlm(intent: LlmIntent, context: RouterContext): Promise<string | null> {
    if (!this.llm) {
      return llmUnavailableMessage(intent);
    }
    return executeLlmPath(intent, context, {
      llm: this.llm,
      logger: this.logger,
      registry: this.registry,
      clarify: this.clarify,
      resolveMusicForCommand: (cmd, ctx) => this.resolveMusicForCommand(cmd, ctx),
      executeDeterministic: (d, ctx) => this.executeDeterministic(d, ctx),
    });
  }
}
