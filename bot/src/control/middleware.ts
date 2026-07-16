/**
 * Control middleware building blocks (PR-A1).
 *
 * Wired optionally into CommandRegistry. ControlRouter still owns the full
 * rights/radio/demo policy in executeParsedCommand; these helpers are the
 * extractable forms for gradual migration (PR-A2+).
 */
import { AUDIO_COMMANDS } from "../bot/commands.js";
import type { ControlMiddleware } from "./registry.js";
import { invokerFields } from "./router.js";

/** Structured log before handler (does not change result). */
export const logInvoker: ControlMiddleware = async (ctx, cmd, _decision, next) => {
  ctx.logger.info(
    { command: cmd.name, ...invokerFields(ctx) },
    "control middleware",
  );
  return next();
};

/**
 * Deny when canRun is present and returns false for the command name.
 * (Does not replace radio.* / test.skip special cases in the router.)
 */
export const rightsGate: ControlMiddleware = async (ctx, cmd, _decision, next) => {
  if (ctx.canRun && !ctx.canRun(cmd.name)) {
    return `You don't have permission to use '${cmd.name}'.`;
  }
  return next();
};

/** Block audio-gated commands when the bot is not connected to TeamSpeak. */
export const audioGuard: ControlMiddleware = async (ctx, cmd, _decision, next) => {
  if (AUDIO_COMMANDS.has(cmd.name) && !ctx.bot.isConnected()) {
    return "Bot is not connected to TeamSpeak";
  }
  return next();
};

/** Compose middleware left-to-right (first registered runs first). */
export function composeMiddleware(...mws: ControlMiddleware[]): ControlMiddleware {
  return async (ctx, cmd, decision, next) => {
    let i = 0;
    const run = async (): Promise<string | null> => {
      if (i < mws.length) {
        const mw = mws[i++];
        return mw(ctx, cmd, decision, run);
      }
      return next();
    };
    return run();
  };
}
