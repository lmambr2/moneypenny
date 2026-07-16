import { describe, expect, it } from "vitest";
import { loadMcpConfig } from "./config.js";

describe("loadMcpConfig", () => {
  it("disabled by default", () => {
    const c = loadMcpConfig({});
    expect(c.enabled).toBe(false);
  });

  it("requires token even when MCP_ENABLED=1", () => {
    const c = loadMcpConfig({ MCP_ENABLED: "1", MCP_TOKEN: "" });
    expect(c.enabled).toBe(false);
  });

  it("enables with token", () => {
    const c = loadMcpConfig({ MCP_ENABLED: "true", MCP_TOKEN: "secret" });
    expect(c.enabled).toBe(true);
    expect(c.token).toBe("secret");
    expect(c.path).toBe("/mcp");
    expect(c.defaultProfile).toBe("admin");
  });

  it("normalizes path", () => {
    expect(loadMcpConfig({ MCP_ENABLED: "1", MCP_TOKEN: "t", MCP_PATH: "mcp" }).path).toBe(
      "/mcp",
    );
    expect(loadMcpConfig({ MCP_ENABLED: "1", MCP_TOKEN: "t", MCP_PATH: "/mcp/" }).path).toBe(
      "/mcp",
    );
  });

  it("parses profiles", () => {
    expect(
      loadMcpConfig({ MCP_ENABLED: "1", MCP_TOKEN: "t", MCP_DEFAULT_PROFILE: "readonly" })
        .defaultProfile,
    ).toBe("readonly");
    expect(
      loadMcpConfig({ MCP_ENABLED: "1", MCP_TOKEN: "t", MCP_DEFAULT_PROFILE: "dj" }).defaultProfile,
    ).toBe("dj");
  });

  it("defaults requireConfirm true; moderation off", () => {
    const c = loadMcpConfig({ MCP_ENABLED: "1", MCP_TOKEN: "t" });
    expect(c.requireConfirm).toBe(true);
    expect(c.enableModeration).toBe(false);
    expect(
      loadMcpConfig({ MCP_ENABLED: "1", MCP_TOKEN: "t", MCP_REQUIRE_CONFIRM: "0" }).requireConfirm,
    ).toBe(false);
    expect(
      loadMcpConfig({ MCP_ENABLED: "1", MCP_TOKEN: "t", MCP_ENABLE_MODERATION: "1" })
        .enableModeration,
    ).toBe(true);
  });
});
