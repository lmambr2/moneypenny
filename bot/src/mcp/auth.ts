import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import type { McpConfig } from "./config.js";
import type { McpSubject } from "./types.js";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    // Still compare to reduce timing signal on length
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Extract Bearer token from Authorization header. */
export function extractBearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h || typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/**
 * Validate bearer against MCP_TOKEN. Phase 1: single service token → profile.
 * Returns null when invalid / missing.
 */
export function authenticateMcpRequest(req: Request, config: McpConfig): McpSubject | null {
  if (!config.enabled || !config.token) return null;
  const token = extractBearerToken(req);
  if (!token || !safeEqual(token, config.token)) return null;

  return {
    kind: "mcp",
    tokenId: "service",
    invokerUid: config.invokerUid,
    invokerName: config.invokerName,
    rightsProfile: config.defaultProfile,
  };
}

/** Minimum profile required for a tool (inclusive ladder). */
const PROFILE_RANK: Record<string, number> = {
  readonly: 0,
  dj: 1,
  admin: 2,
};

export function profileAllows(subject: McpSubject, required: "readonly" | "dj" | "admin"): boolean {
  return (PROFILE_RANK[subject.rightsProfile] ?? -1) >= (PROFILE_RANK[required] ?? 99);
}
