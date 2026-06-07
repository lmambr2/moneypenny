import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type BotDatabase } from "../../data/database.js";
import { createUserStore } from "../../data/users.js";
import { createSessionStore } from "../../data/sessions.js";
import { createRequireAuth } from "../middleware/requireAuth.js";
import { createBotRouter } from "./bot.js";
import { getDefaultConfig, type BotConfig } from "../../data/config.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";

// Records updateLlm / updateRights / updateIdleTimeout calls for assertions.
function fakeBot() {
  return {
    calls: [] as Array<[string, any[]]>,
    updateIdleTimeout(...a: any[]) { this.calls.push(["idle", a]); },
    updateLlm(...a: any[]) { this.calls.push(["llm", a]); },
    updateRights(...a: any[]) { this.calls.push(["rights", a]); },
    getStatus() { return { id: "b1" }; },
    getLlmStatus: async () => ({ configured: true, available: true }),
    askLlm: async (q: string) => `echo:${q}`,
  };
}

describe("bot settings router", () => {
  let botDb: BotDatabase;
  let app: express.Express;
  let adminCookie: string;
  let memberCookie: string;
  let config: BotConfig;
  let configDir: string;
  let bot: ReturnType<typeof fakeBot>;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const admin = await users.createUser("admin", "pw-admin1", "admin");
    const member = await users.createUser("bob", "pw-bob1234", "member");
    adminCookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(admin.id).token}`;
    memberCookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(member.id).token}`;

    config = getDefaultConfig();
    configDir = mkdtempSync(join(tmpdir(), "moneypenny-cfg-"));
    const configPath = join(configDir, "config.json");
    bot = fakeBot();

    const botManager = {
      getAllBots: () => [bot],
      getBot: () => undefined,
      getBotConfig: () => undefined,
      getAllBotsStatus: () => [],
    } as any;
    const avatarStore = {} as any;

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createRequireAuth(sessions));
    app.use("/api/bot", createBotRouter(botManager, config, configPath, console as any, botDb, avatarStore));
  });

  afterEach(() => {
    botDb.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("GET /settings reaches the settings handler (not shadowed by /:id)", async () => {
    const res = await request(app).get("/api/bot/settings").set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ llmEnabled: false, rightsEnabled: true, adminGroups: [] });
  });

  it("POST /settings requires admin", async () => {
    const res = await request(app).post("/api/bot/settings").set("Cookie", memberCookie).send({ llmEnabled: true });
    expect(res.status).toBe(403);
  });

  it("updates LLM settings and applies them live", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", adminCookie)
      .send({ llmEnabled: true, llmUrl: "http://npu:8080", llmModel: "qwen3-4b" });
    expect(res.status).toBe(200);
    expect(config.llmEnabled).toBe(true);
    expect(config.llmModel).toBe("qwen3-4b");
    // Persisted to disk.
    expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8")).llmUrl).toBe("http://npu:8080");
    // Applied to the running bot — llm only (idle/rights untouched).
    expect(bot.calls).toEqual([["llm", [true, "http://npu:8080", "qwen3-4b"]]]);
  });

  it("updates rights settings and applies them live", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", adminCookie)
      .send({ rightsEnabled: true, adminGroups: [6, 7] });
    expect(res.status).toBe(200);
    expect(config.rightsEnabled).toBe(true);
    expect(config.adminGroups).toEqual([6, 7]);
    expect(bot.calls).toEqual([["rights", [true, undefined]]]);
  });

  it("rejects invalid adminGroups", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", adminCookie)
      .send({ adminGroups: [1, -2, "x"] });
    expect(res.status).toBe(400);
    expect(bot.calls).toEqual([]); // nothing applied
  });

  it("only re-applies the subsystems that changed", async () => {
    await request(app).post("/api/bot/settings").set("Cookie", adminCookie).send({ idleTimeoutMinutes: 5 });
    expect(bot.calls).toEqual([["idle", [5]]]);
  });

  it("GET /llm/status reports the running bot's LLM status", async () => {
    const res = await request(app).get("/api/bot/llm/status").set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: true, available: true });
  });

  it("POST /llm/ask returns an answer (admin only)", async () => {
    const forbidden = await request(app).post("/api/bot/llm/ask").set("Cookie", memberCookie).send({ question: "hi" });
    expect(forbidden.status).toBe(403);

    const res = await request(app).post("/api/bot/llm/ask").set("Cookie", adminCookie).send({ question: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe("echo:hi");
  });

  it("POST /llm/ask rejects an empty question", async () => {
    const res = await request(app).post("/api/bot/llm/ask").set("Cookie", adminCookie).send({ question: "  " });
    expect(res.status).toBe(400);
  });
});
