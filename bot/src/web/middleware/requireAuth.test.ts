import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore } from "../../data/users.js";
import { createSessionStore } from "../../data/sessions.js";
import { createRequireAuth } from "./requireAuth.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";

describe("requireAuth middleware", () => {
  let botDb: BotDatabase;
  let app: express.Express;
  let validToken: string;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const u = await users.createUser("alice", "pw-alice", "admin");
    validToken = sessions.createSession(u.id).token;

    app = express();
    app.use(cookieParser());
    app.use(createRequireAuth(sessions));
    app.get("/protected", (req, res) => {
      res.json({ ok: true, user: (req as any).user });
    });
  });

  afterEach(() => {
    botDb.close();
  });

  it("rejects requests without a session cookie", async () => {
    const res = await request(app).get("/protected");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthenticated" });
  });

  it("rejects requests with an unknown session cookie", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE_NAME}=garbage`);
    expect(res.status).toBe(401);
  });

  it("allows requests with a valid session cookie and attaches req.user", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${validToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user.username).toBe("alice");
    expect(res.body.user.role).toBe("admin");
  });

  it("rolls the cookie max-age forward on successful auth", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${validToken}`);
    expect(res.status).toBe(200);
    const setCookieHeaders = res.headers["set-cookie"];
    const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : setCookieHeaders ? [setCookieHeaders] : [];
    const refreshed = arr.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
    expect(refreshed).toBeDefined();
    expect(refreshed!).toMatch(/Max-Age=\d+/);
  });
});
