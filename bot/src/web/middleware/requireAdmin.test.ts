import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore } from "../../data/users.js";
import { createSessionStore } from "../../data/sessions.js";
import { createRequireAuth } from "./requireAuth.js";
import { requireAdmin } from "./requireAdmin.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";

describe("requireAdmin middleware", () => {
  let botDb: BotDatabase;
  let app: express.Express;
  let adminCookie: string;
  let memberCookie: string;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const admin = await users.createUser("admin", "pw-admin-pw", "admin");
    const member = await users.createUser("member", "pw-member-pw", "member");
    adminCookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(admin.id).token}`;
    memberCookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(member.id).token}`;
    app = express();
    app.use(cookieParser());
    app.use(createRequireAuth(sessions));
    app.use(requireAdmin);
    app.get("/admin-only", (_req, res) => res.json({ ok: true }));
  });

  afterEach(() => botDb.close());

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app).get("/admin-only");
    expect(res.status).toBe(401);
  });

  it("rejects member with 403", async () => {
    const res = await request(app).get("/admin-only").set("Cookie", memberCookie);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
  });

  it("allows admin", async () => {
    const res = await request(app).get("/admin-only").set("Cookie", adminCookie);
    expect(res.status).toBe(200);
  });
});
