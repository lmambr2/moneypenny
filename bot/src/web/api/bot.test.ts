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
import { createPlayerRouter } from "./player.js";
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
      getBot: (id: string) => (id === "b1" ? playerBot : undefined),
      getBotConfig: () => undefined,
      getAllBotsStatus: () => [],
    } as any;
    const avatarStore = {} as any;

    // Enhanced fake for player router tests (supports executeCommand and queue/player access used by some endpoints)
    const playerBot = {
      ...bot,
      isConnected: () => true,
      executeCommand: async (cmd: any) => `executed:${cmd.name}`,
      getStatus: () => ({ id: "b1" }),
      getPlayer: () => ({ getElapsed: () => 0, stop: () => {}, resetFailures: () => {}, seek: () => {} }),
      getQueue: () => [],
      getQueueManager: () => ({ size: () => 0, clear: () => {}, add: () => {}, playAt: () => null, play: () => null, current: () => ({ id: "x", platform: "local", name: "Test", artist: "A" }), getCurrentIndex: () => -1, getMode: () => "seq" }),
      resolveAndPlay: async () => true,
      getProviderFor: () => ({}),
    } as any;

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createRequireAuth(sessions));
    app.use("/api/bot", createBotRouter(botManager, config, configPath, console as any, botDb, avatarStore));
    app.use("/api/player", createPlayerRouter(botManager as any, console as any));
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

  // Tests for the new requireAdmin guards on privileged player controls.
  // These confirm web 'member' users can no longer bypass TS rank permissions for admin commands.
  it("privileged player actions require admin (stop, clear, volume, remove, etc.)", async () => {
    const memberStop = await request(app).post("/api/player/b1/stop").set("Cookie", memberCookie);
    expect(memberStop.status).toBe(403);

    const adminStop = await request(app).post("/api/player/b1/stop").set("Cookie", adminCookie);
    expect(adminStop.status).toBe(200);

    const memberClear = await request(app).post("/api/player/b1/clear").set("Cookie", memberCookie);
    expect(memberClear.status).toBe(403);

    const memberVolume = await request(app).post("/api/player/b1/volume").set("Cookie", memberCookie).send({ volume: 50 });
    expect(memberVolume.status).toBe(403);

    const memberRemove = await request(app).delete("/api/player/b1/queue/0").set("Cookie", memberCookie);
    expect(memberRemove.status).toBe(403);
  });

  it("basic playback controls remain available to any authenticated user", async () => {
    const memberPause = await request(app).post("/api/player/b1/pause").set("Cookie", memberCookie);
    expect(memberPause.status).toBe(200);

    const memberPlay = await request(app).post("/api/player/b1/play").set("Cookie", memberCookie).send({ query: "test song" });
    expect(memberPlay.status).toBe(200);

    const memberAdd = await request(app).post("/api/player/b1/add").set("Cookie", memberCookie).send({ query: "another" });
    expect(memberAdd.status).toBe(200);
  });

  it("queue-disruptive controls (play-at) and profile updates require admin", async () => {
    const memberPlayAt = await request(app).post("/api/player/b1/play-at").set("Cookie", memberCookie).send({ index: 0 });
    expect(memberPlayAt.status).toBe(403);

    const memberProfile = await request(app).put("/api/player/b1/profile").set("Cookie", memberCookie).send({ avatarEnabled: false });
    expect(memberProfile.status).toBe(403);
  });

  it("music-request endpoints (play/queue a specific song) are available to any authenticated user", async () => {
    // Same capability as /play and /add — and what the web UI uses for normal
    // playback. Gating these as admin (the earlier draft) broke member playback.
    const song = { id: "x", platform: "local", name: "Test" };
    const memberPlaySong = await request(app).post("/api/player/b1/play-song").set("Cookie", memberCookie).send({ song });
    expect(memberPlaySong.status).toBe(200);

    const adminPlaySong = await request(app).post("/api/player/b1/play-song").set("Cookie", adminCookie).send({ song });
    expect(adminPlaySong.status).toBe(200);
  });
});
