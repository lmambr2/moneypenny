import { describe, expect, it } from "vitest";
import { loadMcpConfig } from "./config.js";
import { errEnvelope, okEnvelope } from "./result.js";
import type { McpContext } from "./types.js";

function ctx(): McpContext {
  return {
    config: loadMcpConfig({ MCP_ENABLED: "1", MCP_TOKEN: "t" }),
    botManager: { getAllBots: () => [], getBot: () => undefined } as any,
    logger: { info: () => {}, error: () => {} } as any,
    subject: {
      kind: "mcp",
      tokenId: "service",
      invokerUid: "mcp:service",
      invokerName: "test",
      rightsProfile: "admin",
    },
    startedAt: Date.now() - 5,
    requestId: "req-envelope",
  };
}

describe("okEnvelope / errEnvelope", () => {
  it("okEnvelope puts botId in meta.bot_id and keeps code OK", () => {
    const c = ctx();
    const env = okEnvelope(c, "Playing", { song: "x" }, "b1");
    expect(env.ok).toBe(true);
    expect(env.code).toBe("OK");
    expect(env.message).toBe("Playing");
    expect(env.data).toEqual({ song: "x" });
    expect(env.meta.bot_id).toBe("b1");
    expect(env.meta.request_id).toBe("req-envelope");
    expect(env.meta.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("okEnvelope without botId leaves meta.bot_id undefined and code OK", () => {
    const env = okEnvelope(ctx(), "ok", { a: 1 });
    expect(env.code).toBe("OK");
    expect(env.meta.bot_id).toBeUndefined();
  });

  it("errEnvelope keeps code and botId distinct", () => {
    const env = errEnvelope(ctx(), "PERMISSION_DENIED", "nope", "b1");
    expect(env.ok).toBe(false);
    expect(env.code).toBe("PERMISSION_DENIED");
    expect(env.meta.bot_id).toBe("b1");
  });
});
