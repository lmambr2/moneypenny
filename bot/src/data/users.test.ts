import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, type BotDatabase } from "./database.js";
import { createUserStore, UsernameTakenError, type UserStore } from "./users.js";

describe("UserStore", () => {
  let botDb: BotDatabase;
  let users: UserStore;

  beforeEach(() => {
    botDb = createDatabase(":memory:");
    users = createUserStore(botDb.db);
  });

  afterEach(() => {
    botDb.close();
  });

  it("countUsers is 0 on a fresh db", () => {
    expect(users.countUsers()).toBe(0);
  });

  it("createUser stores the user and bumps countUsers", async () => {
    const u = await users.createUser("alice", "pw-hunter2", "member");
    expect(u.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(u.username).toBe("alice");
    expect(users.countUsers()).toBe(1);
  });

  it("findByUsername is case-insensitive and returns null for missing", async () => {
    await users.createUser("Alice", "pw-alice", "member");
    expect(users.findByUsername("ALICE")).not.toBeNull();
    expect(users.findByUsername("alice")).not.toBeNull();
    expect(users.findByUsername("bob")).toBeNull();
  });

  it("createUser rejects duplicate usernames (case-insensitive)", async () => {
    await users.createUser("Alice", "pw-alice", "member");
    await expect(users.createUser("alice", "pw-alice-2", "member")).rejects.toBeInstanceOf(UsernameTakenError);
  });

  it("verifyPassword accepts correct password and rejects wrong one", async () => {
    await users.createUser("alice", "correct-horse-battery-staple", "member");
    const row = users.findByUsername("alice");
    expect(row).not.toBeNull();
    expect(await users.verifyPassword("correct-horse-battery-staple", row!.passwordHash)).toBe(true);
    expect(await users.verifyPassword("wrong", row!.passwordHash)).toBe(false);
  });

  it("changePassword updates the hash so the old password no longer verifies", async () => {
    const u = await users.createUser("alice", "old-pw-pw", "member");
    await users.changePassword(u.id, "new-pw-pw");
    const row = users.findByUsername("alice");
    expect(await users.verifyPassword("old-pw-pw", row!.passwordHash)).toBe(false);
    expect(await users.verifyPassword("new-pw-pw", row!.passwordHash)).toBe(true);
  });

  it("listUsers returns id+username+createdAt ascending, no password hash", async () => {
    await users.createUser("alice", "pw-alice", "member");
    await users.createUser("bob", "pw-bob-bob", "member");
    const list = users.listUsers();
    expect(list).toHaveLength(2);
    expect(list[0].username).toBe("alice");
    expect(list[1].username).toBe("bob");
    expect(list[0]).not.toHaveProperty("passwordHash");
    expect(list[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof list[0].createdAt).toBe("number");
  });

  it("deleteUser removes the row and returns true; returns false for unknown id", async () => {
    const u = await users.createUser("alice", "pw-alice", "member");
    expect(users.deleteUser(u.id)).toBe(true);
    expect(users.countUsers()).toBe(0);
    expect(users.deleteUser("not-a-real-id")).toBe(false);
  });

  it("createFirstUser succeeds on empty db, returns null when a user already exists", async () => {
    const a = await users.createFirstUser("alice", "pw-alice");
    expect(a).not.toBeNull();
    expect(a!.username).toBe("alice");
    const b = await users.createFirstUser("bob", "pw-bob-bob");
    expect(b).toBeNull();
    expect(users.countUsers()).toBe(1);
  });

  it("createFirstUser is race-safe: concurrent calls produce exactly one user", async () => {
    const [a, b, c] = await Promise.all([
      users.createFirstUser("alice", "pw-alice"),
      users.createFirstUser("bob", "pw-bob-bob"),
      users.createFirstUser("charlie", "pw-charlie-pw"),
    ]);
    const created = [a, b, c].filter((u) => u !== null);
    expect(created).toHaveLength(1);
    expect(users.countUsers()).toBe(1);
  });

  it("createFirstUser always creates an admin", async () => {
    const u = await users.createFirstUser("alice", "pw-alice");
    expect(u).not.toBeNull();
    expect(u!.role).toBe("admin");
  });

  it("countAdmins reflects only role=admin", async () => {
    await users.createUser("alice", "pw-alice", "admin");
    await users.createUser("bob", "pw-bob-bob", "member");
    expect(users.countUsers()).toBe(2);
    expect(users.countAdmins()).toBe(1);
  });

  it("setRole changes the role and returns true; false for unknown id", async () => {
    const u = await users.createUser("alice", "pw-alice", "member");
    expect(users.setRole(u.id, "admin")).toBe(true);
    expect(users.findById(u.id)!.role).toBe("admin");
    expect(users.setRole("nope", "admin")).toBe(false);
  });

  it("listUsers includes role", async () => {
    await users.createUser("alice", "pw-alice", "admin");
    await users.createUser("bob", "pw-bob-bob", "member");
    const list = users.listUsers();
    const alice = list.find((u) => u.username === "alice")!;
    const bob = list.find((u) => u.username === "bob")!;
    expect(alice.role).toBe("admin");
    expect(bob.role).toBe("member");
  });

  it("setRoleIfNotLastAdmin returns 'would_orphan' for the only admin being demoted", async () => {
    const alice = await users.createUser("alice", "pw-alice", "admin");
    expect(users.setRoleIfNotLastAdmin(alice.id, "member")).toBe("would_orphan");
    expect(users.findById(alice.id)!.role).toBe("admin"); // unchanged
  });

  it("setRoleIfNotLastAdmin allows demotion when another admin exists", async () => {
    const alice = await users.createUser("alice", "pw-alice", "admin");
    await users.createUser("bob", "pw-bob-bob", "admin");
    expect(users.setRoleIfNotLastAdmin(alice.id, "member")).toBe("ok");
    expect(users.findById(alice.id)!.role).toBe("member");
  });

  it("setRoleIfNotLastAdmin returns 'not_found' for unknown id", () => {
    expect(users.setRoleIfNotLastAdmin("not-a-real-id", "member")).toBe("not_found");
  });

  it("setRoleIfNotLastAdmin: concurrent demotions of two admins keep one admin", async () => {
    const alice = await users.createUser("alice", "pw-alice", "admin");
    const bob = await users.createUser("bob", "pw-bob-bob", "admin");
    // Concurrent demotion of both
    const [r1, r2] = await Promise.all([
      Promise.resolve(users.setRoleIfNotLastAdmin(alice.id, "member")),
      Promise.resolve(users.setRoleIfNotLastAdmin(bob.id, "member")),
    ]);
    // Exactly one should succeed; the other gets "would_orphan"
    const oks = [r1, r2].filter((r) => r === "ok").length;
    const orphans = [r1, r2].filter((r) => r === "would_orphan").length;
    expect(oks).toBe(1);
    expect(orphans).toBe(1);
    // System retains at least one admin
    expect(users.countAdmins()).toBe(1);
  });

  it("deleteUserIfNotLastAdmin returns 'would_orphan' for the only admin", async () => {
    const alice = await users.createUser("alice", "pw-alice", "admin");
    expect(users.deleteUserIfNotLastAdmin(alice.id)).toBe("would_orphan");
    expect(users.findById(alice.id)).not.toBeNull();
  });

  it("deleteUserIfNotLastAdmin allows deleting a member at any count", async () => {
    await users.createUser("alice", "pw-alice", "admin");
    const bob = await users.createUser("bob", "pw-bob-bob", "member");
    expect(users.deleteUserIfNotLastAdmin(bob.id)).toBe("ok");
    expect(users.findById(bob.id)).toBeNull();
  });

  it("deleteUserIfNotLastAdmin: concurrent deletes of two admins keep one admin", async () => {
    const alice = await users.createUser("alice", "pw-alice", "admin");
    const bob = await users.createUser("bob", "pw-bob-bob", "admin");
    const [r1, r2] = await Promise.all([
      Promise.resolve(users.deleteUserIfNotLastAdmin(alice.id)),
      Promise.resolve(users.deleteUserIfNotLastAdmin(bob.id)),
    ]);
    const oks = [r1, r2].filter((r) => r === "ok").length;
    const orphans = [r1, r2].filter((r) => r === "would_orphan").length;
    expect(oks).toBe(1);
    expect(orphans).toBe(1);
    expect(users.countAdmins()).toBe(1);
  });
});
