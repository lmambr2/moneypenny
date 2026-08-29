import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";

const BEARER_SCHEME = "bearer";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Linear Bearer extract — no regex (see mcp/auth.ts). */
export function extractBearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h || typeof h !== "string") return null;
  const trimmed = h.trim();
  if (trimmed.length <= BEARER_SCHEME.length) return null;
  if (trimmed.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME) return null;
  const rest = trimmed.slice(BEARER_SCHEME.length);
  if (rest.length === 0 || !/^\s/.test(rest[0]!)) return null;
  const token = rest.trim();
  return token.length > 0 ? token : null;
}

export function ingestTokenExpected(): string {
  return (process.env.ECONOMY_INGEST_TOKEN || process.env.MCP_TOKEN || "").trim();
}

export function isEconomyIngestPath(req: Request): boolean {
  const url = (req.originalUrl || req.url || "").split("?")[0] ?? "";
  return url.includes("/economy/ingest");
}

/** Valid ingest Bearer on an ingest path → synthetic admin user. */
export function tryEconomyIngestBearer(req: Request): boolean {
  if (!isEconomyIngestPath(req)) return false;
  const expected = ingestTokenExpected();
  if (!expected) return false;
  const token = extractBearerToken(req);
  if (!token || !safeEqual(token, expected)) return false;
  req.user = { id: "ingest:datarunner", username: "datarunner", role: "admin" };
  return true;
}

/** Cookie CSRF does not apply when the client sent Bearer and no session cookie. */
export function isBearerOnlyRequest(req: Request): boolean {
  if (!extractBearerToken(req)) return false;
  const cookie = req.headers.cookie;
  if (!cookie || typeof cookie !== "string") return true;
  return !/moneypenny_session\s*=/.test(cookie);
}
