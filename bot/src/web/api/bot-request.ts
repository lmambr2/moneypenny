import type { BotInstance } from "../../bot/instance.js";

declare module "express-serve-static-core" {
  interface Request {
    /** Set by player router `/:botId` middleware. */
    bot?: BotInstance;
  }
}

/** Request with bot attached (after `/:botId` middleware). */
export type BotScopedRequest = import("express").Request & { bot: BotInstance };

export function requireBot(req: import("express").Request): BotInstance {
  if (!req.bot) throw new Error("Bot not attached to request");
  return req.bot;
}
