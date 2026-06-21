import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;

export type UserRole = "admin" | "member";

export interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
  role: UserRole;
}

export interface UserStore {
  countUsers(): number;
  countAdmins(): number;
  createUser(username: string, password: string, role: UserRole): Promise<UserRow>;
  createFirstUser(username: string, password: string): Promise<UserRow | null>;
  findByUsername(username: string): UserRow | null;
  findById(id: string): UserRow | null;
  verifyPassword(plain: string, hash: string): Promise<boolean>;
  changePassword(userId: string, newPassword: string): Promise<void>;
  setRole(userId: string, role: UserRole): boolean;
  setRoleIfNotLastAdmin(id: string, newRole: UserRole): "ok" | "not_found" | "would_orphan";
  deleteUser(id: string): boolean;
  deleteUserIfNotLastAdmin(id: string): "ok" | "not_found" | "would_orphan";
  listUsers(): Array<{ id: string; username: string; createdAt: number; role: UserRole }>;
}

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`username taken: ${username}`);
    this.name = "UsernameTakenError";
  }
}

export function createUserStore(db: Database.Database): UserStore {
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM users");
  const countAdminsStmt = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
  const insertStmt = db.prepare(
    "INSERT INTO users (id, username, passwordHash, createdAt, updatedAt, role) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const findByUsernameStmt = db.prepare(
    "SELECT id, username, passwordHash, createdAt, updatedAt, role FROM users WHERE username = ? COLLATE NOCASE"
  );
  const findByIdStmt = db.prepare(
    "SELECT id, username, passwordHash, createdAt, updatedAt, role FROM users WHERE id = ?"
  );
  const updatePasswordStmt = db.prepare(
    "UPDATE users SET passwordHash = ?, updatedAt = ? WHERE id = ?"
  );
  const updateRoleStmt = db.prepare(
    "UPDATE users SET role = ?, updatedAt = ? WHERE id = ?"
  );
  const listUsersStmt = db.prepare(
    "SELECT id, username, createdAt, role FROM users ORDER BY createdAt ASC"
  );
  const deleteUserStmt = db.prepare("DELETE FROM users WHERE id = ?");

  return {
    countUsers() {
      return (countStmt.get() as { n: number }).n;
    },

    countAdmins() {
      return (countAdminsStmt.get() as { n: number }).n;
    },

    async createUser(username, password, role) {
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const id = randomUUID();
      const now = Date.now();
      try {
        insertStmt.run(id, username, hash, now, now, role);
      } catch (err) {
        if (err && typeof err === "object" && (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
          throw new UsernameTakenError(username);
        }
        throw err;
      }
      return { id, username, passwordHash: hash, createdAt: now, updatedAt: now, role };
    },

    async createFirstUser(username, password) {
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const id = randomUUID();
      const now = Date.now();
      const run = db.transaction(() => {
        const count = (countStmt.get() as { n: number }).n;
        if (count !== 0) return null;
        try {
          insertStmt.run(id, username, hash, now, now, "admin");
        } catch (err) {
          if (err && typeof err === "object" && (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
            return null;
          }
          throw err;
        }
        return { id, username, passwordHash: hash, createdAt: now, updatedAt: now, role: "admin" } as UserRow;
      });
      return run();
    },

    findByUsername(username) {
      return (findByUsernameStmt.get(username) as UserRow | undefined) ?? null;
    },

    findById(id) {
      return (findByIdStmt.get(id) as UserRow | undefined) ?? null;
    },

    verifyPassword(plain, hash) {
      return bcrypt.compare(plain, hash);
    },

    async changePassword(userId, newPassword) {
      const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
      updatePasswordStmt.run(hash, Date.now(), userId);
    },

    setRole(userId, role) {
      const result = updateRoleStmt.run(role, Date.now(), userId);
      return result.changes > 0;
    },

    setRoleIfNotLastAdmin(id, newRole) {
      const tx = db.transaction(() => {
        const row = findByIdStmt.get(id) as UserRow | undefined;
        if (!row) return "not_found" as const;
        if (row.role === newRole) return "ok" as const; // no-op
        if (row.role === "admin" && newRole === "member") {
          const adminCount = (countAdminsStmt.get() as { n: number }).n;
          if (adminCount <= 1) return "would_orphan" as const;
        }
        updateRoleStmt.run(newRole, Date.now(), id);
        return "ok" as const;
      });
      return tx();
    },

    listUsers() {
      return listUsersStmt.all() as Array<{ id: string; username: string; createdAt: number; role: UserRole }>;
    },

    deleteUser(id) {
      const result = deleteUserStmt.run(id);
      return result.changes > 0;
    },

    deleteUserIfNotLastAdmin(id) {
      const tx = db.transaction(() => {
        const row = findByIdStmt.get(id) as UserRow | undefined;
        if (!row) return "not_found" as const;
        if (row.role === "admin") {
          const adminCount = (countAdminsStmt.get() as { n: number }).n;
          if (adminCount <= 1) return "would_orphan" as const;
        }
        deleteUserStmt.run(id);
        return "ok" as const;
      });
      return tx();
    },
  };
}
