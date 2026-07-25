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

  it("is case-insensitive on the scheme and tolerates extra whitespace", () => {
    expect(extractBearerToken(req("BEARER abc"))).toBe("abc");
    expect(extractBearerToken(req("  Bearer   abc  "))).toBe("abc");
    expect(extractBearerToken(req("Bearer\tabc"))).toBe("abc");
  });

  it("rejects malformed authorization headers", () => {
    expect(extractBearerToken(req("Bearer"))).toBeNull();
    expect(extractBearerToken(req("Bearer   "))).toBeNull();
    // No separator — "BearerXYZ" is not a bearer credential.
    expect(extractBearerToken(req("Bearerabc"))).toBeNull();
    expect(extractBearerToken(req("Basic abc"))).toBeNull();
    expect(extractBearerToken(req(""))).toBeNull();
  });

  // Regression (CodeQL js/polynomial-redos): the old
  // /^Bearer\s+(.+)$/ was ambiguous — \s+ and . both match a space — so a long
  // whitespace run that cannot complete the match backtracked over every split.
  // This runs before authentication, so it was reachable unauthenticated.
  it("parses a pathological whitespace header in linear time", () => {
    const evil = `Bearer${" ".repeat(50_000)}\nx`;
    const start = performance.now();
    const out = extractBearerToken(req(evil));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(250);
    // Whatever it returns, it must not hang; the newline-bearing tail is a token.
    expect(typeof out === "string" || out === null).toBe(true);
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
