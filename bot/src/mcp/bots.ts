import type { BotInstance } from "../bot/instance.js";
import type { BotManager } from "../bot/manager.js";
import type { McpConfig } from "./config.js";
import { errEnvelope, okEnvelope } from "./result.js";
import type { McpContext, McpToolEnvelope } from "./types.js";

export function resolveBot(
  botManager: BotManager,
  config: McpConfig,
  botIdArg?: unknown,
): { bot: BotInstance; botId: string } | { error: string; code: string } {
  const requested =
    typeof botIdArg === "string" && botIdArg.trim()
      ? botIdArg.trim()
      : config.botId;

  if (requested) {
    const bot = botManager.getBot(requested);
    if (!bot) return { code: "BOT_NOT_FOUND", error: `Bot not found: ${requested}` };
    return { bot, botId: bot.id };
  }

  const bots = botManager.getAllBots();
  if (bots.length === 0) return { code: "NO_BOT", error: "No bot instance available" };
  const bot = bots[0];
  return { bot, botId: bot.id };
}

export function withBot(
  ctx: McpContext,
  botIdArg: unknown,
  fn: (bot: BotInstance, botId: string) => Promise<McpToolEnvelope> | McpToolEnvelope,
): Promise<McpToolEnvelope> | McpToolEnvelope {
  const resolved = resolveBot(ctx.botManager, ctx.config, botIdArg);
  if ("error" in resolved) {
    return errEnvelope(ctx, resolved.code, resolved.error);
  }
  return fn(resolved.bot, resolved.botId);
}

export function asWebUser(ctx: McpContext): {
  id: string;
  username: string;
  role: "admin" | "member";
} {
  // Map MCP profiles onto web subjects for ControlRouter rights.
  // - readonly → member (public tools only; mutations blocked earlier by profileAllows)
  // - dj/admin → admin so ban/vol and other admin-token commands pass the rights engine
  //   when adminGroups is configured (MCP already restricts which tools exist per profile).
  const role = ctx.subject.rightsProfile === "readonly" ? "member" : "admin";
  return {
    id: ctx.subject.invokerUid,
    username: ctx.subject.invokerName,
    role,
  };
}

export { okEnvelope, errEnvelope };
