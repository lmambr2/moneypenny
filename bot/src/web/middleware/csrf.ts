import type { NextFunction, Request, Response } from "express";
import { isBearerOnlyRequest } from "../auth/bearer.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Same-origin CSRF protection. For mutating requests, the Origin or Referer
 * header must indicate a host equal to the request's own host.
 *
 * SameSite=Lax on the session cookie blocks classic cross-site form posts;
 * this header check covers the remaining attack surface.
 */
export function csrfOriginCheck(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  // CSRF is a cookie attack. Machine clients (datarunner) send Bearer and no session cookie.
  if (isBearerOnlyRequest(req)) {
    next();
    return;
  }
  // Host comparison is case-insensitive (RFC 4343 / browser Origin host).
  const expectedHost = (req.get("host") ?? "").toLowerCase();
  const originHeader = req.get("origin");
  const refererHeader = req.get("referer");
  const headerHost = hostOf(originHeader) ?? hostOf(refererHeader);
  if (!headerHost || !expectedHost || headerHost !== expectedHost) {
    res.status(403).json({ error: "bad origin" });
    return;
  }
  next();
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}
