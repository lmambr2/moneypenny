import type { CommandExecutor } from "../bot/commands/executor.js";
import { commandsOfKind, type ParsedCommand } from "../bot/commands.js";
import type { KgService } from "../bot/community/kg.js";
import type { MemoryService } from "../bot/community/memory.js";
import type { OpsService } from "../bot/community/ops.js";
import type { RoastService } from "../bot/community/roast.js";
import type { KnowledgeService } from "../bot/knowledge/service.js";
import type { PlaybackEngine } from "../bot/playback/engine.js";
import { type EconomyCommand, handleEconomyCommand } from "../economy/service.js";
import type { TS3TextMessage } from "../ts-protocol/client.js";
import type { ControlRouter, RouterContext } from "./router.js";

/** Command execution surface wired into the ControlRouter. */
export interface CommandHandlerHost {
  commands: CommandExecutor;
  playback: PlaybackEngine;
  roast: RoastService;
  memory: MemoryService;
  kg: KgService;
  ops?: OpsService;
  moderation?: (
    action: "mute" | "kick",
    target: string,
    canRun: (c: string) => boolean,
  ) => Promise<string>;
  knowledge: KnowledgeService;
  /** ACE-Step !generate (optional until configured). */
  generate?: {
    handleGenerate(args: string, invokerKey?: string): Promise<string>;
    playGenerated?(song: import("../music/provider.js").Song): Promise<string>;
  };
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
            return host.playback.addResolvedItem(
              decision.resolvedMusic,
              decision.resolvedMusic.providerPlatform,
            );
          }
          return host.playback.playResolvedItem(
            decision.resolvedMusic,
            decision.resolvedMusic.providerPlatform,
          );
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

  const specialRunners: Record<
    string,
    (cmd: ParsedCommand, ctx: RouterContext) => Promise<string>
  > = {
    roast: async () => host.roast.handleCommand(),
    roastout: async (_cmd, ctx) => host.roast.handleOptOut(ctx.invokerUid),
    roastin: async (_cmd, ctx) => host.roast.handleOptIn(ctx.invokerUid),
    remember: async (cmd, ctx) => host.memory.handleRemember(cmd.args, ctx.invokerUid),
    recall: async (_cmd, ctx) => host.memory.handleRecall(ctx.invokerUid),
    forget: async (cmd, ctx) => host.memory.handleForget(cmd.args, ctx.invokerUid), // awaits MemPalace
    kg: async (cmd, ctx) => host.kg.handleKg(cmd.args, ctx.invokerUid, ctx.canRun),
    diary: async (cmd, ctx) => host.kg.handleDiary(cmd.args, ctx.invokerUid, ctx.canRun),
    ops: async (cmd, ctx) => {
      if (!host.ops) return "Ops status is not available on this bot.";
      return host.ops.handle(cmd.args, ctx.canRun);
    },
    mute: async (cmd, ctx) => {
      const target = cmd.args.trim();
      if (!target) return "Usage: !mute <nickname|clid>";
      if (!host.moderation) return "Moderation is not available on this bot.";
      const canRun = ctx.canRun ?? (() => true);
      return host.moderation("mute", target, canRun);
    },
    kick: async (cmd, ctx) => {
      const target = cmd.args.trim();
      if (!target) return "Usage: !kick <nickname|clid>";
      if (!host.moderation) return "Moderation is not available on this bot.";
      const canRun = ctx.canRun ?? (() => true);
      return host.moderation("kick", target, canRun);
    },
    mine: async (cmd) => handleEconomyCommand("mine" as EconomyCommand, cmd.args),
    refine: async (cmd) => handleEconomyCommand("refine" as EconomyCommand, cmd.args),
    craft: async (cmd) => handleEconomyCommand("craft" as EconomyCommand, cmd.args),
    econ: async (cmd) => handleEconomyCommand("econ" as EconomyCommand, cmd.args),
    reindex: async (cmd) =>
      host.knowledge.handleReindex(cmd.rawArgs.length ? cmd.rawArgs : undefined),
    ingeststatus: async () => host.knowledge.handleIngestStatus(),
    generate: async (cmd, ctx) => {
      if (!host.generate) {
        return "Music generation is not available on this bot.";
      }
      // Rank gate: need canRun("generate") when rights are on.
      if (ctx.canRun && !ctx.canRun("generate")) {
        return "You don't have permission to use !generate (DJ/admin).";
      }
      const msg = await host.generate.handleGenerate(
        cmd.args,
        ctx.invokerUid ?? ctx.invokerName ?? "anon",
      );
      // handleGenerate already queues play when wired via instance (message says queued).
      return msg;
    },
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
