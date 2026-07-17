import { type ParsedCommand, parseCommand } from "../bot/commands.js";
import type { BotInstance } from "../bot/instance.js";
import { profileAllows } from "./auth.js";
import { asWebUser, errEnvelope, okEnvelope } from "./bots.js";
import type { McpContext, McpToolEnvelope } from "./types.js";

/**
 * Run a known !command through the same ControlRouter path as the dashboard.
 */
export async function dispatchCommand(
  ctx: McpContext,
  bot: BotInstance,
  botId: string,
  cmd: ParsedCommand,
  requiredProfile: "readonly" | "dj" | "admin" = "dj",
): Promise<McpToolEnvelope> {
  if (!profileAllows(ctx.subject, requiredProfile)) {
    return errEnvelope(
      ctx,
      "PERMISSION_DENIED",
      `Profile '${ctx.subject.rightsProfile}' cannot run '${cmd.name}' (needs ${requiredProfile}+)`,
      botId,
    );
  }

  const { message, denied } = await bot.executeRoutedCommand(cmd, {
    webUser: asWebUser(ctx),
  });

  if (denied) {
    return errEnvelope(ctx, "PERMISSION_DENIED", message ?? "Permission denied", botId);
  }

  return okEnvelope(ctx, message ?? "ok", { command: cmd.name, message }, botId);
}

export function buildPlayCommand(
  verb: "play" | "add" | "playnext",
  query: string,
  platform?: string,
): ParsedCommand | null {
  const flag =
    platform === "youtube" ? "-y" : platform === "stream" ? "-s" : platform === "local" ? "-l" : "";
  const line = flag ? `!${verb} ${flag} ${query}` : `!${verb} ${query}`;
  return parseCommand(line.trim(), "!");
}

export function simpleCommand(name: string, args = ""): ParsedCommand | null {
  return parseCommand(args ? `!${name} ${args}` : `!${name}`, "!");
}
