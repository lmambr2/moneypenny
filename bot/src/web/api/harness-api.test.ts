import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BotConfig, getDefaultConfig } from "../../data/config.js";
import { type BotDatabase, createDatabase } from "../../data/database.js";
import { createSessionStore } from "../../data/sessions.js";
import { createUserStore } from "../../data/users.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";
import { createRequireAuth } from "../middleware/requireAuth.js";
import { createBotRouter } from "./bot.js";

function fakeBot() {
  return {
    runHarnessTurn: vi.fn(async (q: string, opts?: { mode?: string }) => ({
      id: "t-api",
      at: 1,
      user: q,
      reply: `Answer to ${q}`,
      sources: [
        {
          source: "ops.md",
          text: "Be brief",
          classification: "unclassified",
          score: 0.88,
        },
      ],
      tools:
        opts?.mode === "intent"
          ? [{ name: "now_playing", args: {}, ok: true, result: "silence" }]
          : [],
      mode: opts?.mode ?? "ask",
    })),
    listHarnessTurns: vi.fn(() => []),
    seedOrgKgFactAsync: vi.fn(async (fact: string) => ({
      ok: true,
      message: `Recorded in org KG: ${fact}`,
      syncedToMemPalace: true,
    })),
    listOrgKgFacts: vi.fn(() => [
      { id: 1, subject: "x", fact: "y", validFrom: null, validUntil: null, diary: null },
    ]),
    handleOps: vi.fn(async () => "📋 Ops status\nHost ok"),
    updateIdleTimeout: vi.fn(),
    updateLlm: vi.fn(),
    updateRights: vi.fn(),
    updateStreamBridge: vi.fn(),
    updateMemory: vi.fn(),
    updateMemPalace: vi.fn(),
    getMemPalaceStatus: async () => ({ configured: false, available: false, url: "" }),
    updateAceStep: vi.fn(),
    getAceStepStatus: async () => ({ configured: false, available: false }),
    handleAceStepGenerate: async () => "no",
    updateVoice: vi.fn(),
    getEffectiveRights: async () => ({ subject: {}, rightsEnabled: true, chat: [], voice: [] }),
    getRagStatus: async () => ({ configured: false, available: false, docCount: 0, topK: 4 }),
    queryRag: async () => [],
    getStatus: () => ({ id: "b1" }),
    getLlmStatus: async () => ({ configured: true, available: true }),
    askLlm: async (q: string) => `echo:${q}`,
    getVoiceStatus: async () => ({ enabled: false }),
    testVoiceTurn: async () => ({ transcript: "", reply: "", ttsBytes: 0 }),
  };
}

describe("harness + org-kg API (H1/H2/H5 + R4)", () => {
  let app: express.Express;
  let botDb: BotDatabase;
  let configDir: string;
  let config: BotConfig;
  let bot: ReturnType<typeof fakeBot>;
  let adminCookie: string;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const admin = await users.createUser("admin", "pw-admin1", "admin");
    adminCookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(admin.id).token}`;

    config = getDefaultConfig();
    config.llmEnabled = true;
    configDir = mkdtempSync(join(tmpdir(), "mp-harness-"));
    bot = fakeBot();

    const botManager = {
      getAllBots: () => [bot as any],
      getBot: () => bot as any,
      getBotConfig: () => undefined,
    } as any;

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", createRequireAuth(sessions));
    app.use(
      "/api/bot",
      createBotRouter(
        botManager,
        config,
        join(configDir, "cfg.json"),
        console as any,
        botDb,
        {} as any,
      ),
    );
  });

  afterEach(() => {
    botDb.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("POST /harness/ask returns turn with sources + classification", async () => {
    const res = await request(app)
      .post("/api/bot/harness/ask")
      .set("Cookie", adminCookie)
      .send({ question: "how do we brief?" });
    expect(res.status).toBe(200);
    expect(res.body.turn.reply).toMatch(/Answer to/);
    expect(res.body.turn.sources[0].classification).toBe("unclassified");
    expect(res.body.turn.sources[0].source).toBe("ops.md");
    expect(bot.runHarnessTurn).toHaveBeenCalledWith("how do we brief?", { mode: "ask" });
  });

  it("POST /harness/ask intent mode includes tools", async () => {
    const res = await request(app)
      .post("/api/bot/harness/ask")
      .set("Cookie", adminCookie)
      .send({ question: "play something", mode: "intent" });
    expect(res.status).toBe(200);
    expect(res.body.turn.tools[0].name).toBe("now_playing");
    expect(res.body.turn.tools[0].ok).toBe(true);
  });

  it("POST /org-kg seeds fact", async () => {
    const res = await request(app)
      .post("/api/bot/org-kg")
      .set("Cookie", adminCookie)
      .send({ fact: "FC is Dana" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(bot.seedOrgKgFactAsync).toHaveBeenCalledWith("FC is Dana", "web-admin");
  });

  it("GET /ops/status returns text", async () => {
    const res = await request(app).get("/api/bot/ops/status").set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.text).toMatch(/Ops status/);
  });
});
