import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const MAX_SESSIONS_PER_USER = 10;

export interface SessionValidation {
  userId: string;
  username: string;
  role: "admin" | "member";
}

export interface SessionStore {
  createSession(userId: string): { token: string; expiresAt: number };
  validateAndTouch(rawToken: string): SessionValidation | null;
  deleteSession(rawToken: string): void;
  deleteAllForUser(userId: string, exceptToken?: string): void;
  cleanupExpired(): void;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSessionStore(db: Database.Database): SessionStore {
  const insertStmt = db.prepare(
    "INSERT INTO sessions (id, userId, createdAt, expiresAt, lastSeenAt) VALUES (?, ?, ?, ?, ?)"
  );
  const selectStmt = db.prepare(`
    SELECT s.id, s.userId, s.expiresAt, s.lastSeenAt, u.username, u.role
    FROM sessions s INNER JOIN users u ON u.id = s.userId
    WHERE s.id = ?
  `);
  const deleteByIdStmt = db.prepare("DELETE FROM sessions WHERE id = ?");
  const touchStmt = db.prepare(
    "UPDATE sessions SET lastSeenAt = ?, expiresAt = ? WHERE id = ?"
  );
  const deleteAllForUserStmt = db.prepare("DELETE FROM sessions WHERE userId = ?");
  const deleteAllForUserExceptStmt = db.prepare(
    "DELETE FROM sessions WHERE userId = ? AND id != ?"
  );
  const cleanupStmt = db.prepare("DELETE FROM sessions WHERE expiresAt < ?");
  const countForUserStmt = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE userId = ?");
  const deleteOldestForUserStmt = db.prepare(
    "DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE userId = ? ORDER BY createdAt ASC LIMIT ?)"
  );

  return {
    createSession(userId) {
      // Cap concurrent sessions per user — oldest gets evicted on overflow.
      // Wrap the count → delete → insert in a transaction so concurrent logins
      // for the same user can't both pass the cap check and both insert,
      // ending up 1 over cap (race window between count and insert).
      const token = randomBytes(32).toString("base64url");
      const id = hashToken(token);
      const now = Date.now();
      const expiresAt = now + SESSION_TTL_MS;
      const tx = db.transaction(() => {
        const existing = (countForUserStmt.get(userId) as { n: number }).n;
        if (existing >= MAX_SESSIONS_PER_USER) {
          deleteOldestForUserStmt.run(userId, existing - MAX_SESSIONS_PER_USER + 1);
        }
        insertStmt.run(id, userId, now, expiresAt, now);
      });
      tx();
      return { token, expiresAt };
    },

    validateAndTouch(rawToken) {
      if (!rawToken) return null;
      const id = hashToken(rawToken);
      const row = selectStmt.get(id) as
        | { id: string; userId: string; expiresAt: number; lastSeenAt: number; username: string; role: string }
        | undefined;
      if (!row) return null;
      const now = Date.now();
      if (row.expiresAt < now) {
        deleteByIdStmt.run(id);
        return null;
      }
      if (now - row.lastSeenAt > SESSION_TOUCH_INTERVAL_MS) {
        touchStmt.run(now, now + SESSION_TTL_MS, id);
      }
      return { userId: row.userId, username: row.username, role: row.role as "admin" | "member" };
    },

    deleteSession(rawToken) {
      deleteByIdStmt.run(hashToken(rawToken));
    },

    deleteAllForUser(userId, exceptToken) {
      if (exceptToken) {
        deleteAllForUserExceptStmt.run(userId, hashToken(exceptToken));
      } else {
        deleteAllForUserStmt.run(userId);
      }
    },

    cleanupExpired() {
      cleanupStmt.run(Date.now());
    },
  };
}
