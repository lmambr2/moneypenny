import type { CommandExecutor } from "../bot/commands/executor.js";
import {
  COMMAND_MANIFEST,
  commandsOfKind,
  type ParsedCommand,
} from "../bot/commands.js";
import type { KgService } from "../bot/community/kg.js";
import type { MemoryService } from "../bot/community/memory.js";
import type { OpsService } from "../bot/community/ops.js";
import type { RoastService } from "../bot/community/roast.js";
import type { KnowledgeService } from "../bot/knowledge/service.js";
import type { PlaybackEngine } from "../bot/playback/engine.js";
import { type EconomyCommand, handleEconomyCommand } from "../economy/service.js";
import type { TS3TextMessage } from "@moneypenny/ts6-client";
import type { CommandRegistry } from "./registry.js";
import type { ControlRouter, RouterContext } from "./router.js";

/** Command execution surface wired into the ControlRouter / CommandRegistry. */
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

// Lists are generated from the single command manifest (bot/commands.ts).
const RESOLVED_MUSIC_COMMANDS = commandsOfKind("resolved");
const DELEGATED_COMMANDS = commandsOfKind("delegated");
const SPECIAL_COMMANDS = commandsOfKind("special");

/**
 * Kinds that must have a CommandRegistry handler after registration.
 * `router` kinds (ask/analyst/…) are handled inside ControlRouter, not here.
 */
export const REGISTRY_HANDLER_KINDS = ["resolved", "delegated", "special"] as const;

/** Every command name that registerBotCommands must install. */
export function expectedRegistryHandlerNames(): string[] {
  return COMMAND_MANIFEST.filter((c) =>
    (REGISTRY_HANDLER_KINDS as readonly string[]).includes(c.kind),
  ).map((c) => c.name);
}

/**
 * Wire all deterministic command handlers into a {@link CommandRegistry}.
 * This is the PR-A2 primary registration surface (no ControlRouter required).
 */
export function registerBotCommands(registry: CommandRegistry, host: CommandHandlerHost): void {
  const runCommand = (cmd: ParsedCommand, msg?: TS3TextMessage) => host.commands.execute(cmd, msg);

  for (const name of RESOLVED_MUSIC_COMMANDS) {
    registry.register({
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
    registry.register({
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
    forget: async (cmd, ctx) => host.memory.handleForget(cmd.args, ctx.invokerUid),
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
    trade: async (cmd) => handleEconomyCommand("trade" as EconomyCommand, cmd.args),
    workorder: async (cmd, ctx) => {
      const { handleWorkOrderCommand } = await import("../economy/work-order-service.js");
      return handleWorkOrderCommand(cmd.args, "!", {
        invokerUid: ctx.invokerUid ?? null,
        canClear: ctx.canRun ? () => !!ctx.canRun!("workorder.clear") : undefined,
      });
    },
    "work-items": async () => {
      const { handleWorkItemsCommand } = await import("../economy/work-order-service.js");
      return handleWorkItemsCommand("!");
    },
    workitems: async () => {
      const { handleWorkItemsCommand } = await import("../economy/work-order-service.js");
      return handleWorkItemsCommand("!");
    },
    reindex: async (cmd) =>
      host.knowledge.handleReindex(cmd.rawArgs.length ? cmd.rawArgs : undefined),
    ingeststatus: async () => host.knowledge.handleIngestStatus(),
    generate: async (cmd, ctx) => {
      if (!host.generate) {
        return "Music generation is not available on this bot.";
      }
      if (ctx.canRun && !ctx.canRun("generate")) {
        return "You don't have permission to use !generate (DJ/admin).";
      }
      return host.generate.handleGenerate(
        cmd.args,
        ctx.invokerUid ?? ctx.invokerName ?? "anon",
      );
    },
  };

  for (const name of SPECIAL_COMMANDS) {
    const runner = specialRunners[name];
    if (!runner) {
      throw new Error(`No special-command runner registered for '${name}'`);
    }
    registry.register({ name, execute: async (cmd, ctx) => runner(cmd, ctx) });
  }
}

/**
 * Wire all deterministic command handlers into the ControlRouter's registry.
 * Thin wrapper over {@link registerBotCommands} for existing call sites.
 */
export function registerBotCommandHandlers(router: ControlRouter, host: CommandHandlerHost): void {
  registerBotCommands(router.getRegistry(), host);
}
