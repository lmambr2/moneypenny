import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { createMusicRouter } from "./music.js";
import { TagStore, RadioAnalyzer, defaultRadioConfig, type RadioConfig } from "../../radio/index.js";
import { LocalProvider } from "../../music/local.js";
import type { MusicProvider } from "../../music/provider.js";
import type { CommandRunner } from "../../radio/analyzer.js";

const stub = (platform: MusicProvider["platform"]): MusicProvider =>
  ({ platform, search: vi.fn(), getSongUrl: vi.fn(), setQuality() {}, getQuality: () => "d",
     getSongDetail: vi.fn(), getPlaylistSongs: vi.fn(), getRecommendPlaylists: vi.fn(),
     getAlbumSongs: vi.fn(), getLyrics: vi.fn(), getAuthStatus: vi.fn() }) as unknown as MusicProvider;

function build(role: "admin" | "member" | null, radio: RadioConfig) {
  const tagStore = new TagStore({ db: new Database(":memory:") });
  const run: CommandRunner = vi.fn(async (cmd) => {
    if (cmd.includes("keyfinder")) return { stdout: "Am", ok: true, found: true };
    return { stdout: "120", ok: true, found: true };
  });
  const radioAnalyzer = new RadioAnalyzer({
    tags: tagStore,
    getConfig: () => radio,
    logger: console as never,
    run,
  });
  const local = {
    platform: "local",
    listForAnalysis: vi.fn(async () => [{ absPath: "/m/a.mp3", trackKey: "k1" }]),
    pathForId: vi.fn(async (id: string) => (id === "k1" ? "/m/a.mp3" : null)),
    search: vi.fn(),
    getSongUrl: vi.fn(),
    setQuality() {},
    getQuality: () => "d",
    getSongDetail: vi.fn(),
    getPlaylistSongs: vi.fn(),
    getRecommendPlaylists: vi.fn(),
    getAlbumSongs: vi.fn(),
    getLyrics: vi.fn(),
    getAuthStatus: vi.fn(),
  } as unknown as LocalProvider;

  const app = express();
  app.use(express.json());
  if (role) app.use((req, _res, next) => { req.user = { id: "u1", username: "u", role }; next(); });
  app.use(
    createMusicRouter(local, stub("youtube"), stub("stream"), console as never, {
      tagStore,
      radioAnalyzer,
      getRadioConfig: () => radio,
    }),
  );
  return { app, tagStore, local };
}

describe("GET /analyze/status", () => {
  it("reports enabled + available for admins", async () => {
    const radio = defaultRadioConfig();
    radio.analyzer = { enabled: true, tool: "keyfinder", onIngest: true };
    const { app } = build("admin", radio);
    const res = await request(app).get("/analyze/status");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.available).toBe(true);
  });

  it("rejects non-admins", async () => {
    const { app } = build("member", defaultRadioConfig());
    expect((await request(app).get("/analyze/status")).status).toBe(403);
  });
});

describe("POST /analyze", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects when analyzer disabled", async () => {
    const { app } = build("admin", defaultRadioConfig());
    const res = await request(app).post("/analyze").send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("DISABLED");
  });

  it("runs a full-library batch", async () => {
    const radio = defaultRadioConfig();
    radio.analyzer = { enabled: true, tool: "keyfinder", onIngest: false };
    const { app, tagStore } = build("admin", radio);
    const res = await request(app).post("/analyze").send({});
    expect(res.status).toBe(200);
    expect(res.body.analyzed).toBe(1);
    expect(tagStore.get("k1")).toMatchObject({ musicalKey: "Am", bpm: 120, source: "analyzer" });
  });

  it("analyzes a single track by id", async () => {
    const radio = defaultRadioConfig();
    radio.analyzer = { enabled: true, tool: "keyfinder", onIngest: false };
    const { app, tagStore } = build("admin", radio);
    const res = await request(app).post("/analyze").send({ trackId: "k1" });
    expect(res.status).toBe(200);
    expect(res.body.analyzed).toBe(1);
    expect(tagStore.get("k1")?.bpm).toBe(120);
  });
});