import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import pino from "pino";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore, type UserStore } from "../../data/users.js";
import { createSessionStore, type SessionStore } from "../../data/sessions.js";
import { createAuditStore } from "../../data/audit.js";
import { createSessionRouter } from "./session.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";

function makeApp(botDb: BotDatabase, users: UserStore, sessions: SessionStore) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const audit = createAuditStore(botDb.db);
  app.use("/api/session", createSessionRouter(users, sessions, audit, pino({ level: "silent" })));
  return app;
}

function extractCookie(res: request.Response): string {
  const header = res.headers["set-cookie"];
  const arr = Array.isArray(header) ? header : header ? [header] : [];
  const found = arr.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!found) throw new Error("no session cookie set");
  return found.split(";")[0]; // "tsmb_session=xxxx"
}

describe("session router", () => {
  let botDb: BotDatabase;
  let users: UserStore;
  let sessions: SessionStore;
  let app: express.Express;

  beforeEach(() => {
    botDb = createDatabase(":memory:");
    users = createUserStore(botDb.db);
    sessions = createSessionStore(botDb.db);
    app = makeApp(botDb, users, sessions);
  });

  afterEach(() => botDb.close());

  it("GET /needs-setup returns true on an empty db", async () => {
    const res = await request(app).get("/api/session/needs-setup");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ needsSetup: true });
  });

  it("POST /setup creates the first admin, logs them in, and returns false from /needs-setup afterwards", async () => {
    const setupRes = await request(app)
      .post("/api/session/setup")
      .send({ username: "alice", password: "hunter2-hunter2" });
    expect(setupRes.status).toBe(200);
    expect(setupRes.body.username).toBe("alice");
    extractCookie(setupRes);

    const needs = await request(app).get("/api/session/needs-setup");
    expect(needs.body).toEqual({ needsSetup: false });
  });

  it("POST /setup returns 409 once a user already exists", async () => {
    await users.createUser("admin", "pw-admin-pw", "admin");
    const res = await request(app)
      .post("/api/session/setup")
      .send({ username: "alice", password: "pw" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "already initialized" });
  });

  it("POST /login returns 401 with constant-time delay on bad credentials", async () => {
    await users.createUser("alice", "correct-pw-pw", "admin");
    const start = Date.now();
    const res = await request(app)
      .post("/api/session/login")
      .send({ username: "alice", password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid credentials" });
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
  }, 10_000);

  it("POST /login sets a session cookie on success", async () => {
    await users.createUser("alice", "pw-alice", "admin");
    const res = await request(app)
      .post("/api/session/login")
      .send({ username: "alice", password: "pw-alice" });
    expect(res.status).toBe(200);
    expect(res.body.username).toBe("alice");
    extractCookie(res);
  });

  it("GET /me returns the current user when cookie is present, 401 otherwise", async () => {
    await users.createUser("alice", "pw-alice", "admin");
    const loginRes = await request(app)
      .post("/api/session/login")
      .send({ username: "alice", password: "pw-alice" });
    const cookie = extractCookie(loginRes);

    const me = await request(app).get("/api/session/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe("alice");

    const anon = await request(app).get("/api/session/me");
    expect(anon.status).toBe(401);
  });

  it("POST /logout deletes the session and clears the cookie", async () => {
    await users.createUser("alice", "pw-alice", "admin");
    const loginRes = await request(app)
      .post("/api/session/login")
      .send({ username: "alice", password: "pw-alice" });
    const cookie = extractCookie(loginRes);

    const logout = await request(app).post("/api/session/logout").set("Cookie", cookie);
    expect(logout.status).toBe(204);

    const me = await request(app).get("/api/session/me").set("Cookie", cookie);
    expect(me.status).toBe(401);
  });

  it("POST /change-password requires old password and invalidates other sessions", async () => {
    const u = await users.createUser("alice", "old-pw-pw", "admin");
    const cookieA = extractCookie(
      await request(app).post("/api/session/login").send({ username: "alice", password: "old-pw-pw" })
    );
    const cookieB = extractCookie(
      await request(app).post("/api/session/login").send({ username: "alice", password: "old-pw-pw" })
    );

    const wrongOld = await request(app)
      .post("/api/session/change-password")
      .set("Cookie", cookieA)
      .send({ oldPassword: "WRONG", newPassword: "newpassword" });
    expect(wrongOld.status).toBe(401);

    const ok = await request(app)
      .post("/api/session/change-password")
      .set("Cookie", cookieA)
      .send({ oldPassword: "old-pw-pw", newPassword: "newpassword" });
    expect(ok.status).toBe(204);

    const meA = await request(app).get("/api/session/me").set("Cookie", cookieA);
    expect(meA.status).toBe(200);

    const meB = await request(app).get("/api/session/me").set("Cookie", cookieB);
    expect(meB.status).toBe(401);

    expect(u.id).toBe(meA.body.id);
  });
});
