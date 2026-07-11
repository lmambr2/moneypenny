import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BotConfig, getDefaultConfig } from "../../data/config.js";
import { type BotDatabase, createDatabase } from "../../data/database.js";
import { createSessionStore } from "../../data/sessions.js";
import { createUserStore } from "../../data/users.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";
import { createRequireAuth } from "../middleware/requireAuth.js";
import { createBotRouter } from "./bot.js";
import { createPlayerRouter } from "./player.js";

// Records updateLlm / updateRights / updateIdleTimeout calls for assertions.
function fakeBot() {
  return {
    calls: [] as Array<[string, any[]]>,
    updateIdleTimeout(...a: any[]) {
      this.calls.push(["idle", a]);
    },
    updateLlm(...a: any[]) {
      this.calls.push(["llm", a]);
    },
    updateRights(...a: any[]) {
      this.calls.push(["rights", a]);
    },
    updateStreamBridge(...a: any[]) {
      this.calls.push(["stream", a]);
    },
    updateMemory(...a: any[]) {
      this.calls.push(["memory", a]);
    },
    updateMemPalace(...a: any[]) {
      this.calls.push(["mempalace", a]);
    },
    getMemPalaceStatus: async () => ({
      configured: true,
      available: true,
      url: "http://mempalace:8090",
    }),
    updateAceStep(...a: any[]) {
      this.calls.push(["aceStep", a]);
    },
    getAceStepStatus: async () => ({
      configured: true,
      available: true,
      url: "http://192.168.1.89:7865",
      autoFill: false,
      engine: "ace-step",
    }),
    handleAceStepGenerate(prompt: string, invoker?: string) {
      this.calls.push(["aceGenerate", [prompt, invoker]]);
      return Promise.resolve(`Generated · playing ${prompt}`);
    },
    updateVoice(...a: any[]) {
      this.calls.push(["voice", a]);
    },
    getEffectiveRights: async () => ({
      subject: { uid: "u1", serverGroups: ["105"] },
      rightsEnabled: true,
      chat: ["play"],
      voice: ["play", "stop"],
    }),
    getRagStatus: async () => ({
      configured: true,
      available: true,
      docCount: 2,
      topK: 4,
      vectorDbUrl: "http://qdrant:6333",
      embeddingUrl: "http://ollama:11434",
      embeddingModel: "embeddinggemma",
      ragCollection: "moneypenny_docs",
    }),
    queryRag: async (q: string) => [
      { text: "chunk", source: "doc.md", score: 0.9, classification: "unclassified" },
    ],
    getStatus() {
      return { id: "b1" };
    },
    getLlmStatus: async () => ({ configured: true, available: true }),
    askLlm: async (q: string) => `echo:${q}`,
    getVoiceStatus: async () => ({
      enabled: true,
      active: true,
      sttUrl: "http://stt:9000",
      ttsUrl: "",
      ttsVoice: "en_GB-cori-medium",
      respondWithVoice: true,
      sttAvailable: true,
      ttsAvailable: false,
    }),
    testVoiceTurn: async (transcript: string) => ({
      transcript,
      reply: `executed:${transcript}`,
      ttsBytes: 0,
    }),
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

    // Enhanced fake for player router tests (supports routed commands and queue/player access)
    const playerBot = {
      ...bot,
      isConnected: () => true,
      canWebUserRunCommand: async (user: { role: string }, cmd: string) =>
        user.role === "admin" || !["stop", "clear", "vol", "remove"].includes(cmd),
      executeRoutedCommand: async (cmd: any) => ({
        message: `executed:${cmd.name}`,
        denied: false,
      }),
      getStatus: () => ({ id: "b1" }),
      getPlayer: () => ({
        getElapsed: () => 0,
        stop: () => {},
        resetFailures: () => {},
        seek: () => {},
        getState: () => "idle",
      }),
      getQueue: () => [],
      getQueueManager: () => ({
        size: () => 0,
        clear: () => {},
        add: () => {},
        playAt: () => null,
        play: () => null,
        current: () => ({ id: "x", platform: "local", name: "Test", artist: "A" }),
        getCurrentIndex: () => -1,
        getMode: () => "seq",
      }),
      resolveAndPlay: async () => true,
      getProviderFor: () => ({}),
    } as any;

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createRequireAuth(sessions));
    app.use(
      "/api/bot",
      createBotRouter(botManager, config, configPath, console as any, botDb, avatarStore),
    );
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

  it("GET /settings requires admin", async () => {
    const res = await request(app).get("/api/bot/settings").set("Cookie", memberCookie);
    expect(res.status).toBe(403);
  });

  it("POST /settings requires admin", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", memberCookie)
      .send({ llmEnabled: true });
    expect(res.status).toBe(403);
  });

  it("updates LLM settings and applies them live", async () => {
    const res = await request(app).post("/api/bot/settings").set("Cookie", adminCookie).send({
      llmEnabled: true,
      llmUrl: "http://ollama:11434",
      llmModel: "hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL",
    });
    expect(res.status).toBe(200);
    expect(config.llmEnabled).toBe(true);
    expect(config.llmModel).toBe("hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL");
    // Persisted to disk.
    expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8")).llmUrl).toBe(
      "http://ollama:11434",
    );
    // Applied to the running bot — llm only (idle/rights untouched).
    expect(bot.calls).toEqual([
      [
        "llm",
        [
          true,
          "http://ollama:11434",
          "hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL",
          "",
          0.2,
          "",
          "",
          "",
          "",
        ],
      ],
    ]);
  });

  it("updates rights settings and applies them live", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", adminCookie)
      .send({ rightsEnabled: true, adminGroups: [105, 106] });
    expect(res.status).toBe(200);
    expect(config.rightsEnabled).toBe(true);
    expect(config.adminGroups).toEqual([105, 106]);
    expect(bot.calls).toEqual([["rights", [true, undefined]]]);
  });

  it("persists custom rights JSON and validates shape", async () => {
    const rights = {
      defaultAllow: ["play"],
      commandGroups: { admin: ["stop"] },
      rules: [{ match: { serverGroups: ["105"] }, allow: ["@admin"], scope: "chat" }],
    };
    const ok = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", adminCookie)
      .send({ rights });
    expect(ok.status).toBe(200);
    expect(config.rights).toEqual(rights);
    expect(bot.calls.at(-1)).toEqual(["rights", [true, rights]]);

    const bad = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", adminCookie)
      .send({ rights: { rules: "nope" } });
    expect(bad.status).toBe(400);
  });

  it("updates ACE-Step settings live and reports status", async () => {
    const res = await request(app).post("/api/bot/settings").set("Cookie", adminCookie).send({
      aceStepEnabled: true,
      aceStepUrl: "http://192.168.1.89:7865",
      aceStepAutoFill: true,
      aceStepTimeoutMs: 120000,
    });
    expect(res.status).toBe(200);
    expect(config.aceStepEnabled).toBe(true);
    expect(config.aceStepUrl).toBe("http://192.168.1.89:7865");
    expect(config.aceStepAutoFill).toBe(true);
    expect(bot.calls.some((c) => c[0] === "aceStep")).toBe(true);

    const status = await request(app).get("/api/bot/ace-step/status").set("Cookie", adminCookie);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ configured: true, available: true, engine: "ace-step" });
  });

  it("POST /ace-step/generate runs gen for admin and rejects empty prompt", async () => {
    const forbidden = await request(app)
      .post("/api/bot/ace-step/generate")
      .set("Cookie", memberCookie)
      .send({ prompt: "chill pad" });
    expect(forbidden.status).toBe(403);

    const bad = await request(app)
      .post("/api/bot/ace-step/generate")
      .set("Cookie", adminCookie)
      .send({ prompt: "  " });
    expect(bad.status).toBe(400);

    const ok = await request(app)
      .post("/api/bot/ace-step/generate")
      .set("Cookie", adminCookie)
      .send({ prompt: "late night focus" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      ok: true,
      message: expect.stringMatching(/Generated|playing/i),
    });
    expect(bot.calls.some((c) => c[0] === "aceGenerate" && c[1][0] === "late night focus")).toBe(
      true,
    );
  });

  it("updates stream bridge and voice settings live", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", adminCookie)
      .send({
        streamBridgeUrl: "http://bridge:8081",
        voice: { enabled: true, sttUrl: "http://stt:9000", ttsUrl: "", respondWithVoice: false },
      });
    expect(res.status).toBe(200);
    expect(config.streamBridgeUrl).toBe("http://bridge:8081");
    expect(config.voice?.enabled).toBe(true);
    expect(bot.calls).toContainEqual(["stream", ["http://bridge:8081"]]);
    expect(bot.calls).toContainEqual([
      "voice",
      [expect.objectContaining({ enabled: true, sttUrl: "http://stt:9000" })],
    ]);
  });

  it("updates radio settings (hot-applied: the director reads config live)", async () => {
    const res = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", adminCookie)
      .send({
        radio: {
          enabled: true,
          everyNSongs: 6,
          quietHours: [{ from: "02:00", to: "08:00" }],
          sources: ["prerecorded", "stationId"],
          autoDjRepeat: { enabled: true, maxPlays: 2, cooldownHours: 6 },
        },
      });
    expect(res.status).toBe(200);
    expect(config.radio?.enabled).toBe(true);
    expect(config.radio?.everyNSongs).toBe(6);
    expect(config.radio?.quietHours).toEqual([{ from: "02:00", to: "08:00" }]);
    expect(config.radio?.maxBumperSeconds).toBe(30); // untouched fields keep defaults
    expect(config.radio?.autoDjRepeat).toEqual({
      enabled: true,
      maxPlays: 2,
      cooldownHours: 6,
    });
  });

  it("rejects malformed radio settings", async () => {
    const bad = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", adminCookie)
      .send({ radio: { everyNSongs: -1 } });
    expect(bad.status).toBe(400);
    const badSource = await request(app)
      .post("/api/bot/settings")
      .set("Cookie", adminCookie)
      .send({ radio: { sources: ["prerecorded", "evil"] } });
    expect(badSource.status).toBe(400);
  });

  it("rejects unknown/misshapen radio keys instead of spreading them (S1)", async () => {
    const post = (radio: unknown) =>
      request(app).post("/api/bot/settings").set("Cookie", adminCookie).send({ radio });
    expect((await post({ evilKey: 1 })).status).toBe(400); // unknown key
    expect((await post({ profiles: "nope" })).status).toBe(400); // wrong shape
    expect((await post({ profiles: { mining: [] } })).status).toBe(400); // profile not an object
    expect((await post({ clock: { wheel: "nope" } })).status).toBe(400); // wheel not an array
    expect((await post({ classificationFloor: [1] })).status).toBe(400); // non-string floor
    // Valid shapes still pass and land in config.
    const ok = await post({
      profiles: { mining: { name: "mining" } },
      clock: { wheel: [{ slot: "song" }, { slot: "bumper" }] },
    });
    expect(ok.status).toBe(200);
    expect(config.radio?.profiles?.mining?.name).toBe("mining");
    expect(config.radio?.clock?.wheel).toHaveLength(2);
  });

  it("persists RAG substrate URLs (restart required to apply)", async () => {
    const res = await request(app).post("/api/bot/settings").set("Cookie", adminCookie).send({
      embeddingUrl: "http://gpu:11434",
      embeddingModel: "embeddinggemma",
      vectorDbUrl: "http://qdrant-gpu:6333",
    });
    expect(res.status).toBe(200);
    expect(config.embeddingUrl).toBe("http://gpu:11434");
    expect(config.embeddingModel).toBe("embeddinggemma");
    expect(config.vectorDbUrl).toBe("http://qdrant-gpu:6333");
  });

  it("GET /rag/status and POST /rag/query work for admins", async () => {
    config.ragEnabled = true;
    const status = await request(app).get("/api/bot/rag/status").set("Cookie", adminCookie);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ configured: true, available: true, docCount: 2, topK: 4 });

    const forbidden = await request(app)
      .post("/api/bot/rag/query")
      .set("Cookie", memberCookie)
      .send({ q: "test" });
    expect(forbidden.status).toBe(403);

    const res = await request(app)
      .post("/api/bot/rag/query")
      .set("Cookie", adminCookie)
      .send({ q: "intel report" });
    expect(res.status).toBe(200);
    expect(res.body.chunks[0].source).toBe("doc.md");

    const empty = await request(app)
      .post("/api/bot/rag/query")
      .set("Cookie", adminCookie)
      .send({ q: "  " });
    expect(empty.status).toBe(400);
  });

  it("POST /rag/query rejects when RAG is disabled in config", async () => {
    config.ragEnabled = false;
    const res = await request(app)
      .post("/api/bot/rag/query")
      .set("Cookie", adminCookie)
      .send({ q: "test" });
    expect(res.status).toBe(409);
  });

  it("GET /voice/status and POST /voice/test work for admins", async () => {
    const status = await request(app).get("/api/bot/voice/status").set("Cookie", adminCookie);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ enabled: true, active: true, sttAvailable: true });

    const forbidden = await request(app)
      .post("/api/bot/voice/test")
      .set("Cookie", memberCookie)
      .send({ transcript: "skip" });
    expect(forbidden.status).toBe(403);

    const res = await request(app)
      .post("/api/bot/voice/test")
      .set("Cookie", adminCookie)
      .send({ transcript: "skip" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ transcript: "skip", reply: "executed:skip", ttsBytes: 0 });

    const empty = await request(app)
      .post("/api/bot/voice/test")
      .set("Cookie", adminCookie)
      .send({ transcript: "  " });
    expect(empty.status).toBe(400);
  });

  it("GET /rights/debug returns effective permissions (admin only)", async () => {
    const forbidden = await request(app).get("/api/bot/rights/debug").set("Cookie", memberCookie);
    expect(forbidden.status).toBe(403);

    const res = await request(app)
      .get("/api/bot/rights/debug?groups=105")
      .set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.voice).toContain("stop");
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
    await request(app)
      .post("/api/bot/settings")
      .set("Cookie", adminCookie)
      .send({ idleTimeoutMinutes: 5 });
    expect(bot.calls).toEqual([["idle", [5]]]);
  });

  it("GET /llm/status reports the running bot's LLM status", async () => {
    const res = await request(app).get("/api/bot/llm/status").set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: true, available: true });
  });

  it("POST /llm/ask returns an answer (admin only)", async () => {
    const forbidden = await request(app)
      .post("/api/bot/llm/ask")
      .set("Cookie", memberCookie)
      .send({ question: "hi" });
    expect(forbidden.status).toBe(403);

    const res = await request(app)
      .post("/api/bot/llm/ask")
      .set("Cookie", adminCookie)
      .send({ question: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe("echo:hi");
  });

  it("POST /llm/ask rejects an empty question", async () => {
    const res = await request(app)
      .post("/api/bot/llm/ask")
      .set("Cookie", adminCookie)
      .send({ question: "  " });
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

    const memberVolume = await request(app)
      .post("/api/player/b1/volume")
      .set("Cookie", memberCookie)
      .send({ volume: 50 });
    expect(memberVolume.status).toBe(403);

    const memberRemove = await request(app)
      .delete("/api/player/b1/queue/0")
      .set("Cookie", memberCookie);
    expect(memberRemove.status).toBe(403);
  });

  it("basic playback controls remain available to any authenticated user", async () => {
    const memberPause = await request(app).post("/api/player/b1/pause").set("Cookie", memberCookie);
    expect(memberPause.status).toBe(200);

    const memberPlay = await request(app)
      .post("/api/player/b1/play")
      .set("Cookie", memberCookie)
      .send({ query: "test song" });
    expect(memberPlay.status).toBe(200);

    const memberAdd = await request(app)
      .post("/api/player/b1/add")
      .set("Cookie", memberCookie)
      .send({ query: "another" });
    expect(memberAdd.status).toBe(200);
  });

  it("queue-disruptive controls (play-at) and profile updates require admin", async () => {
    const memberPlayAt = await request(app)
      .post("/api/player/b1/play-at")
      .set("Cookie", memberCookie)
      .send({ index: 0 });
    expect(memberPlayAt.status).toBe(403);

    const memberProfile = await request(app)
      .put("/api/player/b1/profile")
      .set("Cookie", memberCookie)
      .send({ avatarEnabled: false });
    expect(memberProfile.status).toBe(403);
  });

  it("music-request endpoints (play/queue a specific song) are available to any authenticated user", async () => {
    // Same capability as /play and /add — and what the web UI uses for normal
    // playback. Gating these as admin (the earlier draft) broke member playback.
    const song = { id: "x", platform: "local", name: "Test" };
    const memberPlaySong = await request(app)
      .post("/api/player/b1/play-song")
      .set("Cookie", memberCookie)
      .send({ song });
    expect(memberPlaySong.status).toBe(200);

    const adminPlaySong = await request(app)
      .post("/api/player/b1/play-song")
      .set("Cookie", adminCookie)
      .send({ song });
    expect(adminPlaySong.status).toBe(200);
  });
});
