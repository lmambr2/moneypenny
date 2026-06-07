import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, type BotDatabase } from "./database.js";
import { createAuditStore, type AuditStore } from "./audit.js";

describe("AuditStore", () => {
  let botDb: BotDatabase;
  let audit: AuditStore;

  beforeEach(() => {
    botDb = createDatabase(":memory:");
    audit = createAuditStore(botDb.db);
  });

  afterEach(() => botDb.close());

  it("records and lists entries newest-first", async () => {
    audit.record({
      actorId: "a1", actorUsername: "alice",
      targetUserId: "b1", targetUsername: "bob",
      action: "user.created",
    });
    await new Promise((r) => setTimeout(r, 5));
    audit.record({
      actorId: "a1", actorUsername: "alice",
      targetUserId: "b1", targetUsername: "bob",
      action: "user.deleted",
    });
    const list = audit.list(10, 0);
    expect(list).toHaveLength(2);
    expect(list[0].action).toBe("user.deleted");
    expect(list[1].action).toBe("user.created");
  });

  it("supports limit and offset", () => {
    for (let i = 0; i < 5; i++) {
      audit.record({
        actorId: "a1", actorUsername: "alice",
        targetUserId: null, targetUsername: null,
        action: "user.password_changed",
      });
    }
    expect(audit.list(2, 0)).toHaveLength(2);
    expect(audit.list(2, 4)).toHaveLength(1);
    expect(audit.list(10, 10)).toHaveLength(0);
  });

  it("stores nullable fields correctly", () => {
    audit.record({
      actorId: null, actorUsername: null,
      targetUserId: "x", targetUsername: "deleted-user",
      action: "admin.first_created",
    });
    const e = audit.list(1, 0)[0];
    expect(e.actorId).toBeNull();
    expect(e.actorUsername).toBeNull();
    expect(e.targetUserId).toBe("x");
  });
});
