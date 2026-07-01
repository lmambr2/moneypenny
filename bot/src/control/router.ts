import { parseCommand, isKnownCommand, type ParsedCommand } from "../bot/commands.js";
import {
  appendAnalystSaveNotice,
  parseAnalystCommand,
  type AnalystRequest,
} from "../docs/analyst.js";
import {
  buildWorkflowTask,
  formatWorkflowFollowUp,
  parseWorkflowCommand,
  WORKFLOW_ACK_MESSAGE,
  type WorkflowKind,
  type WorkflowRequest,
} from "../docs/workflow.js";
import {
  DELEGATE_ACK_MESSAGE,
  DELEGATE_TOOL_NAME,
  formatDelegateFollowUp,
} from "../llm/delegate.js";
import type { BotInstance } from "../bot/instance.js";
import type { Playlist, Song } from "../music/provider.js";
import type { TS3TextMessage } from "../ts-protocol/client.js";
import type { Logger } from "../logger.js";

/**
 * CommandHandler — registered handlers the router delegates to after routing.
 * Implementations live in register-handlers.ts and BotInstance subsystem delegates.
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
    type: 'song' | 'playlist';
    item: Song | Playlist;
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
  "playlist", "album", "artist", "test", "chevron7",
]);

/** Strip STT punctuation so "Pause." / "Skip?" still match deterministic commands. */
export function normalizeVoiceTranscript(transcript: string): string {
  return transcript
    .trim()
    .replace(/[.!?,;:]+$/u, "")
    .trim();
}

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
    const text = normalizeVoiceTranscript(transcript);
    if (!text) return { type: "unknown" };

    // Parse as if prefixed so flag/alias handling is shared with the chat path.
    const command = parseCommand("!" + text, "!", aliases);
    if (command) {
      command.name = command.name.replace(/[.,!?;:]+$/u, "");
    }
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
      const resolved = await context.bot.resolveLocalMusic(command.args);
      if (resolved) {
        this.logger.debug({ command: command.name, resolvedType: resolved.type }, "Local resolve succeeded in router");
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
    return this.executeDeterministic({ type: "deterministic", command: cmd, resolvedMusic }, context);
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

    // `!radio` is public (status), but toggling power (on/off) needs the admin
    // `radio.power` token (docs/radio.md §12). Granular radio.* tokens + the @dj
    // group arrive in R-R3; R-R1 splits just status vs power.
    if (cmd.name === "radio") {
      const sub = (cmd.rawArgs[0] ?? "").toLowerCase();
      if ((sub === "on" || sub === "off") && context.canRun && !context.canRun("radio.power")) {
        return "You don't have permission to toggle radio mode (needs 'radio.power').";
      }
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

    this.logger.warn({ command: cmd.name }, "No handler registered for command in ControlRouter");
    return `Unknown command. Try ${"!"}help.`;
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
      return this.llm.ask(intent.text, context.conversationId, {
        allowedClassifications: context.allowedClassifications,
        userUid: context.invokerUid,
      });
    }

    if (intent.mode === "delegate") {
      if (context.canRun && !context.canRun("analyst")) {
        return "You don't have permission to use 'analyst'.";
      }
      const parsed = parseAnalystCommand({
        args: intent.text ?? "",
        flags: intent.delegateFlags ?? new Set(),
      });
      if ("error" in parsed) return parsed.error;
      if (this.llm.isDelegateConfigured && !this.llm.isDelegateConfigured()) {
        return "Analyst delegation is not configured. Set a delegate URL in Settings.";
      }
      return this.runDelegate(parsed, undefined, context);
    }

    if (intent.mode === "workflow") {
      const kind = intent.workflowKind ?? "intsum";
      if (context.canRun && !context.canRun(kind)) {
        return `You don't have permission to use '${kind}'.`;
      }
      if (this.llm.isDelegateConfigured && !this.llm.isDelegateConfigured()) {
        return "Analyst delegation is not configured. Set a delegate URL in Settings.";
      }
      const parsed = parseWorkflowCommand(kind, {
        args: intent.text ?? "",
        flags: intent.workflowFlags ?? new Set(),
      });
      if ("error" in parsed) return parsed.error;
      return this.runWorkflow(parsed, context);
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

    const moveClientEnabled = !context.canRun || context.canRun("moveclient");
    const result = await this.llm!.chatForIntent(text, context.conversationId, { moveClientEnabled });
    const toolCalls = result.toolCalls ?? [];

    if (toolCalls.length === 0) {
      // No actionable intent — return the model's plain answer if any.
      return result.content;
    }

    const outputs: string[] = [];
    for (const tc of toolCalls) {
      if (tc.name === DELEGATE_TOOL_NAME) {
        const task = String(tc.arguments?.task ?? "").trim();
        const extra = String(tc.arguments?.context ?? "").trim();
        if (!task) continue;
        if (context.canRun && !context.canRun("analyst")) {
          outputs.push("You don't have permission to delegate to the analyst.");
          continue;
        }
        const req: AnalystRequest = { task, save: false, classification: "restricted" };
        const out = await this.runDelegate(req, extra || undefined, context);
        if (out) outputs.push(out);
        continue;
      }
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

  /**
   * Run delegate work — async (ack + postFollowUp) when the context provides a
   * poster; otherwise await inline (unit tests and callers without TS I/O).
   */
  private async runDelegate(
    req: AnalystRequest,
    extraContext: string | undefined,
    context: RouterContext,
  ): Promise<string> {
    const ctx = {
      allowedClassifications: context.allowedClassifications,
      userUid: context.invokerUid,
    };

    const finish = async (raw: string): Promise<string> => {
      let result = formatDelegateFollowUp(raw, context.invokerName);
      if (req.save) {
        const saved = await context.bot.saveAnalystDoc(raw, req.classification);
        result = appendAnalystSaveNotice(result, saved);
      }
      return result;
    };

    if (!context.postFollowUp) {
      const raw = await this.llm!.delegate(req.task, extraContext, ctx);
      return finish(raw);
    }

    void this.llm!
      .delegate(req.task, extraContext, ctx)
      .then(async (result) => {
        await context.postFollowUp!(await finish(result));
      })
      .catch(async (err) => {
        context.logger.warn({ err, task: req.task.slice(0, 80) }, "Async delegate failed");
        const msg = err instanceof Error ? err.message : "Analyst request failed.";
        try {
          await context.postFollowUp!(formatDelegateFollowUp(msg, context.invokerName));
        } catch (postErr) {
          context.logger.warn({ err: postErr }, "Failed to post delegate error follow-up");
        }
      });

    return DELEGATE_ACK_MESSAGE;
  }

  /**
   * Run workflow doc generation — async ack when postFollowUp is set (R1b pattern).
   */
  private async runWorkflow(req: WorkflowRequest, context: RouterContext): Promise<string> {
    const ctx = {
      allowedClassifications: context.allowedClassifications,
      userUid: context.invokerUid,
    };

    const finish = async (raw: string): Promise<string> => {
      let result = raw;
      if (req.save) {
        const saved = await context.bot.saveWorkflowDoc(req.kind, raw);
        result = saved.ok
          ? `${raw}\n\n💾 Saved to knowledge base: ${saved.source}`
          : `${raw}\n\n⚠️ Could not save: ${saved.error}`;
      }
      return result;
    };

    const generate = () => {
      if (this.llm!.generateWorkflowDoc) {
        return this.llm!.generateWorkflowDoc(req, ctx);
      }
      return this.llm!.delegate(buildWorkflowTask(req), undefined, ctx);
    };

    if (!context.postFollowUp) {
      return finish(await generate());
    }

    void generate()
      .then(async (raw) => {
        await context.postFollowUp!(formatWorkflowFollowUp(req.kind, await finish(raw), context.invokerName));
      })
      .catch(async (err) => {
        context.logger.warn({ err, kind: req.kind }, "Async workflow failed");
        const msg = err instanceof Error ? err.message : "Document draft failed.";
        try {
          await context.postFollowUp!(formatWorkflowFollowUp(req.kind, msg, context.invokerName));
        } catch (postErr) {
          context.logger.warn({ err: postErr }, "Failed to post workflow error follow-up");
        }
      });

    return WORKFLOW_ACK_MESSAGE;
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
export function toolCallToCommand(tc: { name: string; arguments?: Record<string, unknown> }): ParsedCommand | null {
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
      return { ...make("play", query), flags: sourceFlags(typeof a.source === "string" ? a.source : undefined) };
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
    case "move_client": {
      const client = String(a.client ?? a.target ?? "").trim();
      const channel = String(a.channel ?? "").trim();
      if (!client || !channel) return null;
      return {
        name: "moveclient",
        args: `${client} ${channel}`,
        rawArgs: [client, channel],
        flags: new Set<string>(),
      };
    }
    case "move_all_clients": {
      const channel = String(a.channel ?? "").trim();
      if (!channel) return null;
      return make("moveall", channel);
    }
    default:
      return null;
  }
}
