import type { BotManager } from "../bot/manager.js";
import type { Logger } from "../logger.js";
import type { McpConfig, McpProfile } from "./config.js";

export interface McpSubject {
  kind: "mcp";
  tokenId: string;
  invokerUid: string;
  invokerName: string;
  rightsProfile: McpProfile;
}

/** Stable application-level result envelope (docs/mcp-server.md §9). */
export interface McpToolEnvelope<T = unknown> {
  ok: boolean;
  code: string;
  message: string;
  data: T | null;
  meta: {
    bot_id?: string;
    duration_ms: number;
    request_id?: string;
  };
}

export interface McpContext {
  config: McpConfig;
  botManager: BotManager;
  logger: Logger;
  subject: McpSubject;
  /** Wall-clock start for this tool call. */
  startedAt: number;
  requestId: string;
}

export type McpToolHandler = (
  args: Record<string, unknown>,
  ctx: McpContext,
) => Promise<McpToolEnvelope>;
