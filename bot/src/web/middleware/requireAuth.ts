import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { SessionStore } from "../../data/sessions.js";
import { SESSION_TTL_MS } from "../../data/sessions.js";
import {
  validateSessionFromHeaders,
  extractSessionToken,
  SESSION_COOKIE_NAME,
} from "../auth/validateSession.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: { id: string; username: string; role: "admin" | "member" };
  }
}

export function createRequireAuth(sessions: SessionStore): RequestHandler {
  return function requireAuth(req: Request, res: Response, next: NextFunction) {
    const result = validateSessionFromHeaders(req.headers.cookie, sessions);
    if (!result) {
      res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    req.user = { id: result.userId, username: result.username, role: result.role };
    const token = extractSessionToken(req.headers.cookie);
    if (token) {
      res.cookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: req.secure,
        path: "/",
        maxAge: SESSION_TTL_MS,
      });
    }
    next();
  };
}
