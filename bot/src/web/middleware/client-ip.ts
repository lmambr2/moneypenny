/**
 * Client IP derivation for rate limits behind reverse proxies (audit M-2026-07-09-3).
 * When trustProxy is on, only the rightmost `hops` X-Forwarded-For entries are
 * trusted (operator must configure proxy to overwrite XFF at the edge).
 */
import type { Request } from "express";

export interface ClientIpOpts {
  trustProxy: boolean;
  /** Number of trusted reverse-proxy hops (default 1). Clamped 0–5. */
  trustProxyHops?: number;
}

/**
 * Resolve a stable rate-limit key for the remote client.
 * - trustProxy false → req.socket.remoteAddress (or req.ip)
 * - trustProxy true → take the hop `hops` from the right of XFF, else remoteAddress
 */
export function resolveClientIp(req: Request, opts: ClientIpOpts): string {
  const hops = Math.max(0, Math.min(5, opts.trustProxyHops ?? 1));
  if (!opts.trustProxy || hops === 0) {
    return socketIp(req) || "unknown";
  }

  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff.join(",") : (xff ?? "");
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return socketIp(req) || "unknown";
  }

  // Rightmost hop is closest to our proxy; hop 1 = last entry, hop 2 = second last, …
  const idx = parts.length - hops;
  const chosen = parts[Math.max(0, idx)] ?? parts[parts.length - 1];
  return chosen || socketIp(req) || "unknown";
}

function socketIp(req: Request): string {
  const ra = req.socket?.remoteAddress;
  if (ra) return ra;
  return typeof req.ip === "string" ? req.ip : "";
}

/** Express rateLimit keyFn factory. */
export function clientIpKeyFn(opts: ClientIpOpts): (req: Request) => string {
  return (req) => resolveClientIp(req, opts);
}
