import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { authenticateMcpRequest, extractBearerToken, profileAllows } from "./auth.js";
import type { McpConfig } from "./config.js";

const baseConfig = (): McpConfig => ({
  enabled: true,
  token: "test-token-xyz",
  path: "/mcp",
  botId: null,
  defaultProfile: "admin",
  allowRawCommand: false,
  enableModeration: false,
  requireConfirm: true,
  invokerName: "grok-build",
  invokerUid: "mcp:service",
});

function req(auth?: string): Request {
  return { headers: auth ? { authorization: auth } : {} } as Request;
}

describe("MCP auth", () => {
  it("extracts bearer token", () => {
    expect(extractBearerToken(req("Bearer abc"))).toBe("abc");
    expect(extractBearerToken(req("bearer abc"))).toBe("abc");
    expect(extractBearerToken(req())).toBeNull();
  });

  it("accepts matching token", () => {
    const s = authenticateMcpRequest(req("Bearer test-token-xyz"), baseConfig());
    expect(s?.rightsProfile).toBe("admin");
    expect(s?.invokerUid).toBe("mcp:service");
  });

  it("rejects wrong token", () => {
    expect(authenticateMcpRequest(req("Bearer wrong"), baseConfig())).toBeNull();
  });

  it("rejects when disabled", () => {
    const c = { ...baseConfig(), enabled: false };
    expect(authenticateMcpRequest(req("Bearer test-token-xyz"), c)).toBeNull();
  });

  it("profile ladder", () => {
    const sub = {
      kind: "mcp" as const,
      tokenId: "service",
      invokerUid: "u",
      invokerName: "n",
      rightsProfile: "dj" as const,
    };
    expect(profileAllows(sub, "readonly")).toBe(true);
    expect(profileAllows(sub, "dj")).toBe(true);
    expect(profileAllows(sub, "admin")).toBe(false);
  });
});
