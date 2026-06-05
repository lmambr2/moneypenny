import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore } from "../../data/users.js";
import { createSessionStore } from "../../data/sessions.js";
import { createAuditStore } from "../../data/audit.js";
import { createRequireAuth } from "../middleware/requireAuth.js";
import { createAuditRouter } from "./audit.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";

describe("audit router", () => {
  let botDb: BotDatabase;
  let app: express.Express;
  let cookie: string;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const audit = createAuditStore(botDb.db);
    const alice = await users.createUser("alice", "pw-alice", "admin");
    cookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(alice.id).token}`;
    for (let i = 0; i < 3; i++) {
      audit.record({
        actorId: alice.id, actorUsername: "alice",
        targetUserId: "x", targetUsername: "x",
        action: "user.created",
      });
    }
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createRequireAuth(sessions));
    app.use("/api/audit", createAuditRouter(audit));
  });

  afterEach(() => botDb.close());

  it("requires auth", async () => {
    const res = await request(app).get("/api/audit");
    expect(res.status).toBe(401);
  });

  it("returns entries newest-first", async () => {
    const res = await request(app).get("/api/audit").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(3);
  });

  it("honors limit query param", async () => {
    const res = await request(app).get("/api/audit?limit=1").set("Cookie", cookie);
    expect(res.body.entries).toHaveLength(1);
  });
});
