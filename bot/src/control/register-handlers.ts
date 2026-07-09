import { commandsOfKind, type ParsedCommand } from "../bot/commands.js";
import type { TS3TextMessage } from "../ts-protocol/client.js";
import type { RoastService } from "../bot/community/roast.js";
import type { MemoryService } from "../bot/community/memory.js";
import type { KgService } from "../bot/community/kg.js";
import type { KnowledgeService } from "../bot/knowledge/service.js";
import type { PlaybackEngine } from "../bot/playback/engine.js";
import type { CommandExecutor } from "../bot/commands/executor.js";
import type { ControlRouter, RouterContext } from "./router.js";
import { handleEconomyCommand, type EconomyCommand } from "../economy/service.js";

/** Command execution surface wired into the ControlRouter. */
export interface CommandHandlerHost {
  commands: CommandExecutor;
  playback: PlaybackEngine;
  roast: RoastService;
  memory: MemoryService;
  kg: KgService;
  knowledge: KnowledgeService;
}

// All three lists are generated from the single command manifest
// (bot/src/bot/commands.ts) — adding a command there wires it here for free.
const RESOLVED_MUSIC_COMMANDS = commandsOfKind("resolved");
const DELEGATED_COMMANDS = commandsOfKind("delegated");
const SPECIAL_COMMANDS = commandsOfKind("special");

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

  const specialRunners: Record<string, (cmd: ParsedCommand, ctx: RouterContext) => Promise<string>> = {
    roast: async () => host.roast.handleCommand(),
    roastout: async (_cmd, ctx) => host.roast.handleOptOut(ctx.invokerUid),
    roastin: async (_cmd, ctx) => host.roast.handleOptIn(ctx.invokerUid),
    remember: async (cmd, ctx) => host.memory.handleRemember(cmd.args, ctx.invokerUid),
    recall: async (_cmd, ctx) => host.memory.handleRecall(ctx.invokerUid),
    forget: async (cmd, ctx) => host.memory.handleForget(cmd.args, ctx.invokerUid), // awaits MemPalace
    kg: async (cmd, ctx) => host.kg.handleKg(cmd.args, ctx.invokerUid, ctx.canRun),
    diary: async (cmd, ctx) => host.kg.handleDiary(cmd.args, ctx.invokerUid, ctx.canRun),
    mine: async (cmd) => handleEconomyCommand("mine" as EconomyCommand, cmd.args),
    refine: async (cmd) => handleEconomyCommand("refine" as EconomyCommand, cmd.args),
    craft: async (cmd) => handleEconomyCommand("craft" as EconomyCommand, cmd.args),
    econ: async (cmd) => handleEconomyCommand("econ" as EconomyCommand, cmd.args),
    reindex: async (cmd) => host.knowledge.handleReindex(cmd.rawArgs.length ? cmd.rawArgs : undefined),
    ingeststatus: async () => host.knowledge.handleIngestStatus(),
  };

  for (const name of SPECIAL_COMMANDS) {
    const runner = specialRunners[name];
    if (!runner) {
      // A manifest "special" entry without a runner is a wiring bug — fail at
      // startup, not with a silent unknown-command at use time.
      throw new Error(`No special-command runner registered for '${name}'`);
    }
    router.registerHandler({ name, execute: async (cmd, ctx) => runner(cmd, ctx) });
  }
}