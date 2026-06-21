import type Database from "better-sqlite3";

export type AuditAction =
  | "admin.first_created"
  | "user.created"
  | "user.deleted"
  | "user.password_reset"
  | "user.password_changed"
  | "user.role_changed";

export interface AuditEntry {
  id: number;
  timestamp: number;
  actorId: string | null;
  actorUsername: string | null;
  targetUserId: string | null;
  targetUsername: string | null;
  action: AuditAction;
}

export interface AuditRecordInput {
  actorId: string | null;
  actorUsername: string | null;
  targetUserId: string | null;
  targetUsername: string | null;
  action: AuditAction;
}

export interface AuditStore {
  record(input: AuditRecordInput): void;
  list(limit: number, offset: number): AuditEntry[];
}

export function createAuditStore(db: Database.Database): AuditStore {
  const insertStmt = db.prepare(
    "INSERT INTO user_audit (timestamp, actorId, actorUsername, targetUserId, targetUsername, action) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const listStmt = db.prepare(
    "SELECT id, timestamp, actorId, actorUsername, targetUserId, targetUsername, action FROM user_audit ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?"
  );

  return {
    record(input) {
      insertStmt.run(
        Date.now(),
        input.actorId,
        input.actorUsername,
        input.targetUserId,
        input.targetUsername,
        input.action
      );
    },
    list(limit, offset) {
      return listStmt.all(limit, offset) as AuditEntry[];
    },
  };
}
