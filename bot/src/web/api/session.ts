import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import type { AuditStore } from "../../data/audit.js";
import type { SessionStore } from "../../data/sessions.js";
import { SESSION_TTL_MS } from "../../data/sessions.js";
import type { UserStore } from "../../data/users.js";
import type { Logger } from "../../logger.js";
import {
  extractSessionToken,
  SESSION_COOKIE_NAME,
  validateSessionFromHeaders,
} from "../auth/validateSession.js";
import { parseWithSchema, zPassword, zUsername } from "../validate.js";

const FAILED_LOGIN_DELAY_MS = 250;

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: res.req.secure,
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSessionRouter(
  users: UserStore,
  sessions: SessionStore,
  audit: AuditStore,
  logger: Logger,
): Router {
  const router = Router();

  const requireAuthInline = (req: Request, res: Response, next: NextFunction) => {
    const result = validateSessionFromHeaders(req.headers.cookie, sessions);
    if (!result) {
      clearSessionCookie(res);
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    req.user = { id: result.userId, username: result.username, role: result.role };
    const token = extractSessionToken(req.headers.cookie);
    if (token) setSessionCookie(res, token);
    next();
  };

  router.get("/needs-setup", (_req, res) => {
    res.json({ needsSetup: users.countUsers() === 0 });
  });

  router.post("/setup", async (req, res) => {
    if (users.countUsers() !== 0) {
      res.status(409).json({ error: "already initialized" });
      return;
    }
    const parsed = parseWithSchema(
      z.object({ username: zUsername, password: zPassword }),
      req.body ?? {},
    );
    if (!parsed.ok) {
      res.status(400).json({ error: "invalid username or password" });
      return;
    }
    const { username, password } = parsed.data;
    try {
      const user = await users.createFirstUser(username, password);
      if (!user) {
        res.status(409).json({ error: "already initialized" });
        return;
      }
      const { token } = sessions.createSession(user.id);
      setSessionCookie(res, token);
      try {
        audit.record({
          actorId: user.id,
          actorUsername: user.username,
          targetUserId: user.id,
          targetUsername: user.username,
          action: "admin.first_created",
        });
      } catch (auditErr) {
        logger.warn({ err: auditErr, action: "admin.first_created" }, "audit insert failed");
      }
      logger.info({ userId: user.id, username }, "First admin created");
      res.json({ id: user.id, username: user.username, role: user.role });
    } catch (err) {
      logger.error({ err }, "setup failed");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
    }
  });

  router.post("/login", async (req, res) => {
    const parsed = parseWithSchema(
      z.object({ username: z.string().min(1), password: z.string().min(1) }),
      req.body ?? {},
    );
    if (!parsed.ok) {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const { username, password } = parsed.data;
    const user = users.findByUsername(username);
    const ok = user ? await users.verifyPassword(password, user.passwordHash) : false;
    if (!user || !ok) {
      await delay(FAILED_LOGIN_DELAY_MS);
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    const { token } = sessions.createSession(user.id);
    setSessionCookie(res, token);
    res.json({ id: user.id, username: user.username, role: user.role });
  });

  router.post("/logout", (req, res) => {
    const token = extractSessionToken(req.headers.cookie);
    if (token) {
      sessions.deleteSession(token);
    }
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.get("/me", requireAuthInline, (req, res) => {
    res.json(req.user);
  });

  router.post("/change-password", requireAuthInline, async (req, res) => {
    const { oldPassword, newPassword } = req.body ?? {};
    if (typeof oldPassword !== "string") {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    const u = users.findById(req.user!.id);
    if (!u || !(await users.verifyPassword(oldPassword, u.passwordHash))) {
      await delay(FAILED_LOGIN_DELAY_MS);
      res.status(401).json({ error: "invalid credentials" });
      return;
    }
    const newParsed = parseWithSchema(zPassword, newPassword);
    if (!newParsed.ok) {
      res.status(400).json({ error: "invalid request" });
      return;
    }
    await users.changePassword(u.id, newParsed.data);
    const currentToken = extractSessionToken(req.headers.cookie);
    sessions.deleteAllForUser(u.id, currentToken ?? undefined);
    try {
      audit.record({
        actorId: u.id,
        actorUsername: u.username,
        targetUserId: u.id,
        targetUsername: u.username,
        action: "user.password_changed",
      });
    } catch (auditErr) {
      logger.warn({ err: auditErr, action: "user.password_changed" }, "audit insert failed");
    }
    res.status(204).end();
  });

  return router;
}
