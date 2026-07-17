/**
 * Pre-handler gates for deterministic commands (PR-A4).
 * Extracted from ControlRouter.executeDeterministic for testability.
 */
import { AUDIO_COMMANDS } from "../bot/commands.js";
import type { ParsedCommand } from "../bot/commands.js";
import type { Logger } from "../logger.js";
import { invokerFields, type RouterContext } from "./router.js";

/**
 * Returns a denial message if gated, or null if execution may proceed.
 * Order matches historical ControlRouter policy.
 */
export function applyDeterministicGates(
  cmd: ParsedCommand,
  context: RouterContext,
  logger: Logger,
): string | null {
  // Rank gating (DESIGN §8)
  if (context.canRun && !context.canRun(cmd.name)) {
    logger.debug({ command: cmd.name, ...invokerFields(context) }, "Command denied by rights");
    return `You don't have permission to use '${cmd.name}'.`;
  }

  // !test demo track: only ranks with `test.skip` may interrupt it.
  if (context.canRun) {
    const demoInterrupt =
      cmd.name === "next" ||
      cmd.name === "skip" ||
      cmd.name === "clear" ||
      cmd.name === "stop" ||
      cmd.name === "play" ||
      cmd.name === "playlist" ||
      cmd.name === "album" ||
      cmd.name === "artist" ||
      cmd.name === "chevron7";
    if (demoInterrupt) {
      const demoPlaying =
        typeof context.bot.isDemoTestPlaying === "function" && context.bot.isDemoTestPlaying();
      if (demoPlaying && !context.canRun("test.skip")) {
        logger.debug(
          { command: cmd.name, ...invokerFields(context) },
          "Demo track interrupt denied — needs test.skip (Chairman / server admin)",
        );
        return "Only Chairman or server admin can skip or replace the !test demo track.";
      }
    }
  }

  // `!radio` sensitive subcommands (docs/radio.md §12)
  if (cmd.name === "radio" && context.canRun) {
    const sub = (cmd.rawArgs[0] ?? "").toLowerCase();
    if ((sub === "on" || sub === "off") && !context.canRun("radio.power")) {
      return "You don't have permission to toggle radio mode (needs 'radio.power').";
    }
    const opsArg = (cmd.rawArgs[1] ?? "").toLowerCase();
    if (sub === "ops" && opsArg && opsArg !== "list" && !context.canRun("radio.ops")) {
      return "You don't have permission to set the op context (needs 'radio.ops').";
    }
    for (const [name, token] of [
      ["bumper", "radio.bumper"],
      ["say", "radio.say"],
      ["skip", "radio.skip"],
      ["pin", "radio.pin"],
    ] as const) {
      if (sub === name && !context.canRun(token)) {
        return `You don't have permission to use 'radio ${name}' (needs '${token}').`;
      }
    }
  }

  if (!context.bot.isConnected() && AUDIO_COMMANDS.has(cmd.name)) {
    return "Bot is not connected to TeamSpeak";
  }

  return null;
}
