import { Router } from "express";
import type { Logger } from "../../logger.js";
import type { UserStore } from "../../data/users.js";
import { UsernameTakenError } from "../../data/users.js";
import type { SessionStore } from "../../data/sessions.js";
import type { AuditStore } from "../../data/audit.js";
import { extractSessionToken } from "../auth/validateSession.js";

function isValidUsername(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_\-.]{3,32}$/.test(v);
}

function isValidPassword(v: unknown): v is string {
  return typeof v === "string" && v.length >= 8 && v.length <= 200;
}

export function createUsersRouter(
  users: UserStore,
  sessions: SessionStore,
  audit: AuditStore,
  logger: Logger
): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ users: users.listUsers() });
  });

  router.post("/", async (req, res) => {
    const { username, password, role: roleInput } = req.body ?? {};
    if (!isValidUsername(username) || !isValidPassword(password)) {
      res.status(400).json({ error: "invalid username or password" });
      return;
    }
    const role: "admin" | "member" = roleInput === "admin" ? "admin" : "member";
    try {
      const u = await users.createUser(username, password, role);
      try {
        audit.record({
          actorId: req.user!.id, actorUsername: req.user!.username,
          targetUserId: u.id, targetUsername: u.username,
          action: "user.created",
        });
      } catch (auditErr) {
        logger.warn({ err: auditErr, action: "user.created" }, "audit insert failed");
      }
      logger.info({ createdBy: req.user!.id, newUserId: u.id, username, role }, "User created");
      res.status(201).json({ id: u.id, username: u.username, role: u.role });
    } catch (err) {
      if (err instanceof UsernameTakenError) {
        res.status(409).json({ error: "username taken" });
        return;
      }
      logger.error({ err }, "createUser failed");
      res.status(500).json({ error: "internal" });
    }
  });

  router.delete("/:id", (req, res) => {
    const targetId = req.params.id;
    // Snapshot target's username BEFORE deletion for audit
    const target = users.findById(targetId);
    if (!target) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (targetId === req.user!.id) {
      res.status(400).json({ error: "cannot delete self" });
      return;
    }
    const result = users.deleteUserIfNotLastAdmin(targetId);
    if (result === "not_found") {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (result === "would_orphan") {
      res.status(400).json({ error: "cannot delete last admin" });
      return;
    }
    // FK CASCADE removes sessions; explicit call is belt-and-suspenders
    sessions.deleteAllForUser(targetId);
    try {
      audit.record({
        actorId: req.user!.id, actorUsername: req.user!.username,
        targetUserId: target.id, targetUsername: target.username,
        action: "user.deleted",
      });
    } catch (auditErr) {
      logger.warn({ err: auditErr, action: "user.deleted" }, "audit insert failed");
    }
    logger.info({ deletedBy: req.user!.id, deletedUserId: targetId }, "User deleted");
    res.status(204).end();
  });

  router.post("/:id/reset-password", async (req, res) => {
    const { newPassword } = req.body ?? {};
    if (!isValidPassword(newPassword)) {
      res.status(400).json({ error: "invalid password" });
      return;
    }
    const targetId = req.params.id;
    const target = users.findById(targetId);
    if (!target) {
      res.status(404).json({ error: "not found" });
      return;
    }
    await users.changePassword(targetId, newPassword);
    // Invalidate all sessions for the target user (except current actor's if it's the same user)
    const exceptToken = targetId === req.user!.id
      ? (extractSessionToken(req.headers.cookie) ?? undefined)
      : undefined;
    sessions.deleteAllForUser(targetId, exceptToken);
    try {
      audit.record({
        actorId: req.user!.id, actorUsername: req.user!.username,
        targetUserId: target.id, targetUsername: target.username,
        action: "user.password_reset",
      });
    } catch (auditErr) {
      logger.warn({ err: auditErr, action: "user.password_reset" }, "audit insert failed");
    }
    logger.info({ resetBy: req.user!.id, targetUserId: targetId }, "Password reset");
    res.status(204).end();
  });

  router.patch("/:id/role", (req, res) => {
    const targetId = req.params.id;
    const { role: newRole } = req.body ?? {};
    if (newRole !== "admin" && newRole !== "member") {
      res.status(400).json({ error: "invalid role" });
      return;
    }
    // Snapshot the target's old role and username for audit (BEFORE the atomic update,
    // so we record what actually changed; if the user is gone we'll skip audit).
    const targetBefore = users.findById(targetId);
    if (!targetBefore) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const result = users.setRoleIfNotLastAdmin(targetId, newRole);
    if (result === "not_found") {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (result === "would_orphan") {
      res.status(400).json({ error: "cannot demote last admin" });
      return;
    }
    // Only audit when the role actually changed
    if (targetBefore.role !== newRole) {
      try {
        audit.record({
          actorId: req.user!.id, actorUsername: req.user!.username,
          targetUserId: targetBefore.id, targetUsername: targetBefore.username,
          action: "user.role_changed",
        });
      } catch (auditErr) {
        logger.warn({ err: auditErr, action: "user.role_changed" }, "audit insert failed");
      }
      logger.info({ actorId: req.user!.id, targetId, newRole }, "User role changed");
    }
    res.status(204).end();
  });

  return router;
}
