/**
 * API tests for hardening leftovers + G3 live + recordings (2026-07 backlog).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditStore } from "../../data/audit.js";
import { type BotConfig, getDefaultConfig } from "../../data/config.js";
import { type BotDatabase, createDatabase } from "../../data/database.js";
import { createSessionStore } from "../../data/sessions.js";
import { createUserStore } from "../../data/users.js";
import { SESSION_COOKIE_NAME } from "../auth/validateSession.js";
import { createRequireAuth } from "../middleware/requireAuth.js";
import { createBotRouter } from "./bot.js";

function fakeBot() {
  return {
    getLiveStatus: vi.fn(async () => ({
      connected: true,
      nowPlaying: { name: "Track A", artist: "Artist" },
      queue: [{ name: "Next", artist: "B" }],
      radio: {
        enabled: true,
        activeProfile: "lobby",
        songsUntilBumper: 2,
        cuePending: false,
        nextBumperHint: "Next bumper in 2 track(s)",
      },
      scope: {
        channelHint: "Ops",
        serverLabel: "SC-TS",
        virtualServerId: "1",
        channelPinned: true,
      },
    })),
    getLlmStatus: async () => ({ configured: true, available: true }),
    listPrivateMemory: vi.fn(() => [{ id: 1, fact: "secret", createdAt: 1 }]),
    updateIdleTimeout: vi.fn(),
    updateLlm: vi.fn(),
    updateRights: vi.fn(),
    updateStreamBridge: vi.fn(),
    updateMemory: vi.fn(),
    updateMemPalace: vi.fn(),
    getMemPalaceStatus: async () => ({ configured: false, available: false, url: "" }),
    updateAceStep: vi.fn(),
    getAceStepStatus: async () => ({ configured: false, available: false }),
    updateVoice: vi.fn(),
    getEffectiveRights: async () => ({ subject: {}, rightsEnabled: true, chat: [], voice: [] }),
    getRagStatus: async () => ({ configured: false, available: false, docCount: 0, topK: 4 }),
    getStatus: () => ({ id: "b1" }),
    getVoiceStatus: async () => ({ enabled: false }),
  };
}

describe("backlog API: hardening + live + recordings", () => {
  let app: express.Express;
  let botDb: BotDatabase;
  let configDir: string;
  let config: BotConfig;
  let bot: ReturnType<typeof fakeBot>;
  let adminCookie: string;
  let memberCookie: string;
  let audit: ReturnType<typeof createAuditStore>;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    audit = createAuditStore(botDb.db);
    const admin = await users.createUser("admin", "pw-admin1", "admin");
    const member = await users.createUser("member", "pw-member1", "member");
    adminCookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(admin.id).token}`;
    memberCookie = `${SESSION_COOKIE_NAME}=${sessions.createSession(member.id).token}`;

    config = getDefaultConfig();
    config.recordingsEnabled = true;
    configDir = mkdtempSync(join(tmpdir(), "mp-backlog-"));
    bot = fakeBot();

    const botManager = {
      getAllBots: () => [bot as any],
      getBot: () => bot as any,
      getBotConfig: () => undefined,
    } as any;

    app = express();
    app.use(express.json({ limit: "2mb" }));
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
        audit,
      ),
    );
  });

  afterEach(() => {
    botDb.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("GET /llm/status is admin-only (L-2026-07-09-1)", async () => {
    const denied = await request(app).get("/api/bot/llm/status").set("Cookie", memberCookie);
    expect(denied.status).toBe(403);

    const ok = await request(app).get("/api/bot/llm/status").set("Cookie", adminCookie);
    expect(ok.status).toBe(200);
    expect(ok.body.configured).toBe(true);
  });

  it("GET /live is readable by members (G3)", async () => {
    const res = await request(app).get("/api/bot/live").set("Cookie", memberCookie);
    expect(res.status).toBe(200);
    expect(res.body.nowPlaying.name).toBe("Track A");
    expect(res.body.queue[0].name).toBe("Next");
    expect(res.body.radio.nextBumperHint).toMatch(/bumper/i);
    expect(res.body.scope.serverLabel).toBe("SC-TS");
  });

  it("GET /memory/private records audit entry", async () => {
    const res = await request(app).get("/api/bot/memory/private?uid=42").set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.facts[0].fact).toBe("secret");
    const entries = audit.list(20, 0);
    expect(entries.some((e) => e.action === "memory.private_read")).toBe(true);
  });

  it("recordings upload/list/delete under contained store", async () => {
    const b64 = Buffer.from("RIFF....WEBM").toString("base64");
    const up = await request(app)
      .post("/api/bot/recordings")
      .set("Cookie", adminCookie)
      .send({ filename: "take-1.webm", dataBase64: b64, mime: "audio/webm" });
    expect(up.status).toBe(201);
    expect(up.body.recording.filename).toBe("take-1.webm");

    const list = await request(app).get("/api/bot/recordings").set("Cookie", adminCookie);
    expect(list.status).toBe(200);
    expect(list.body.enabled).toBe(true);
    expect(
      list.body.recordings.some((r: { filename: string }) => r.filename === "take-1.webm"),
    ).toBe(true);

    const trav = await request(app)
      .post("/api/bot/recordings")
      .set("Cookie", adminCookie)
      .send({ filename: "../evil.webm", dataBase64: b64 });
    expect(trav.status).toBe(400);

    const memberDenied = await request(app)
      .post("/api/bot/recordings")
      .set("Cookie", memberCookie)
      .send({ filename: "x.webm", dataBase64: b64 });
    expect(memberDenied.status).toBe(403);

    const del = await request(app)
      .delete("/api/bot/recordings/take-1.webm")
      .set("Cookie", adminCookie);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
  });

  it("recordings download sanitizes the Content-Disposition filename", async () => {
    const b64 = Buffer.from("RIFF....WEBM").toString("base64");
    await request(app)
      .post("/api/bot/recordings")
      .set("Cookie", adminCookie)
      .send({ filename: "take-2.webm", dataBase64: b64 });

    const dl = await request(app).get("/api/bot/recordings/take-2.webm").set("Cookie", adminCookie);
    expect(dl.status).toBe(200);
    expect(dl.headers["content-disposition"]).toBe('attachment; filename="take-2.webm"');

    // A quote-bearing name must 404 (sanitized lookup), never echo raw into the header.
    const quoted = await request(app)
      .get(`/api/bot/recordings/${encodeURIComponent('take-2".webm')}`)
      .set("Cookie", adminCookie);
    expect(quoted.status).toBe(404);
    expect(quoted.headers["content-disposition"]).toBeUndefined();
  });

  it("recordings disabled returns empty list / 409 on upload", async () => {
    config.recordingsEnabled = false;
    const list = await request(app).get("/api/bot/recordings").set("Cookie", adminCookie);
    expect(list.status).toBe(200);
    expect(list.body.enabled).toBe(false);

    const up = await request(app)
      .post("/api/bot/recordings")
      .set("Cookie", adminCookie)
      .send({ filename: "a.webm", dataBase64: Buffer.from("x").toString("base64") });
    expect(up.status).toBe(409);
  });
});
