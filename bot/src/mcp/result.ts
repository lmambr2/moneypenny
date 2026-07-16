import type { McpContext, McpToolEnvelope } from "./types.js";

/**
 * Success envelope. Call as `okEnvelope(ctx, message, data, botId?)`.
 * `botId` is the 4th arg (not `code`) — matches every tools/dispatch call site.
 */
export function okEnvelope<T>(
  ctx: McpContext,
  message: string,
  data: T | null = null,
  botId?: string,
  code = "OK",
): McpToolEnvelope<T> {
  return {
    ok: true,
    code,
    message,
    data,
    meta: {
      bot_id: botId,
      duration_ms: Date.now() - ctx.startedAt,
      request_id: ctx.requestId,
    },
  };
}

export function errEnvelope(
  ctx: McpContext,
  code: string,
  message: string,
  botId?: string,
): McpToolEnvelope {
  return {
    ok: false,
    code,
    message,
    data: null,
    meta: {
      bot_id: botId,
      duration_ms: Date.now() - ctx.startedAt,
      request_id: ctx.requestId,
    },
  };
}

/** MCP CallToolResult text content from envelope JSON. */
export function envelopeToToolContent(envelope: McpToolEnvelope): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    isError: !envelope.ok,
  };
}
