import type { ParsedCommand } from "../bot/commands.js";
import type { TS3TextMessage } from "../ts-protocol/client.js";
import type { RoastService } from "../bot/community/roast.js";
import type { MemoryService } from "../bot/community/memory.js";
import type { KgService } from "../bot/community/kg.js";
import type { KnowledgeService } from "../bot/knowledge/service.js";
import type { PlaybackEngine } from "../bot/playback/engine.js";
import type { CommandExecutor } from "../bot/commands/executor.js";
import type { ControlRouter, RouterContext } from "./router.js";

/** Command execution surface wired into the ControlRouter. */
export interface CommandHandlerHost {
  commands: CommandExecutor;
  playback: PlaybackEngine;
  roast: RoastService;
  memory: MemoryService;
  kg: KgService;
  knowledge: KnowledgeService;
}

/** Commands that try LocalProvider.resolve before falling back to executeCommand. */
const RESOLVED_MUSIC_COMMANDS = ["play", "add", "playnext", "pn", "playlist", "album"] as const;

/**
 * Everything else implemented in BotInstance.executeCommand — delegate so the
 * router never runs duplicate/stub handlers (prev, vote, move, lyrics, etc.).
 */
const DELEGATED_COMMANDS = [
  "skip",
  "next",
  "pause",
  "resume",
  "stop",
  "clear",
  "vol",
  "remove",
  "mode",
  "now",
  "queue",
  "list",
  "help",
  "test",
  "lyrics",
  "vote",
  "move",
  "moveclient",
  "moveall",
  "follow",
  "prev",
  "artist",
  "chevron7",
  "radio",
  "rate",
  "unrate",
  "selecttracks",
] as const;

/** Community / knowledge-base commands — not in executeCommand's switch. */
const SPECIAL_COMMANDS = [
  "roast", "roastout", "remember", "recall", "forget",
  "kg", "diary", "reindex", "ingeststatus",
] as const;

/**
 * Wire all deterministic command handlers into the ControlRouter.
 * Keeps BotInstance thinner: routing policy lives here, execution in instance methods.
 */
export function registerBotCommandHandlers(router: ControlRouter, host: CommandHandlerHost): void {
  const runCommand = (cmd: ParsedCommand, msg?: TS3TextMessage) => host.commands.execute(cmd, msg);

  for (const name of RESOLVED_MUSIC_COMMANDS) {
    router.registerHandler({
      name,
      execute: async (cmd, ctx, decision) => {
        if (decision.resolvedMusic) {
          if (name === "add") {
            return host.playback.addResolvedItem(decision.resolvedMusic, decision.resolvedMusic.providerPlatform);
          }
          return host.playback.playResolvedItem(decision.resolvedMusic, decision.resolvedMusic.providerPlatform);
        }
        return runCommand(cmd, ctx.message);
      },
    });
  }

  for (const name of DELEGATED_COMMANDS) {
    router.registerHandler({
      name,
      execute: async (cmd, ctx) => runCommand(cmd, ctx.message),
    });
  }

  const specialRunners: Record<(typeof SPECIAL_COMMANDS)[number], (cmd: ParsedCommand, ctx: RouterContext) => Promise<string>> = {
    roast: async () => host.roast.handleCommand(),
    roastout: async (_cmd, ctx) => host.roast.handleOptOut(ctx.invokerUid),
    remember: async (cmd, ctx) => host.memory.handleRemember(cmd.args, ctx.invokerUid),
    recall: async (_cmd, ctx) => host.memory.handleRecall(ctx.invokerUid),
    forget: async (cmd, ctx) => host.memory.handleForget(cmd.args, ctx.invokerUid),
    kg: async (cmd, ctx) => host.kg.handleKg(cmd.args, ctx.invokerUid, ctx.canRun),
    diary: async (cmd, ctx) => host.kg.handleDiary(cmd.args, ctx.invokerUid, ctx.canRun),
    reindex: async (cmd) => host.knowledge.handleReindex(cmd.rawArgs.length ? cmd.rawArgs : undefined),
    ingeststatus: async () => host.knowledge.handleIngestStatus(),
  };

  for (const name of SPECIAL_COMMANDS) {
    router.registerHandler({
      name,
      execute: async (cmd, ctx) => specialRunners[name](cmd, ctx),
    });
  }
}