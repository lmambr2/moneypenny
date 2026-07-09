import Database from "better-sqlite3";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { MusicProvider } from "../../music/provider.js";
import { TagStore } from "../../radio/index.js";
import { createMusicRouter } from "./music.js";

const stub = (platform: MusicProvider["platform"]): MusicProvider =>
  ({
    platform,
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
  }) as unknown as MusicProvider;

function build(
  role: "admin" | "member" | null,
  opts: { canEditTags?: (u: { role: string }) => boolean | Promise<boolean> } = {},
) {
  const tagStore = new TagStore({ db: new Database(":memory:") });
  const app = express();
  app.use(express.json());
  if (role)
    app.use((req, _res, next) => {
      req.user = { id: "u1", username: "u", role };
      next();
    });
  app.use(
    createMusicRouter(stub("local"), stub("youtube"), stub("stream"), console as never, {
      tagStore,
      canEditTags: opts.canEditTags as never,
    }),
  );
  return { app, tagStore };
}

describe("GET /tracks/:id/tags", () => {
  it("returns overlay tags and aggregate rating", async () => {
    const { app, tagStore } = build("member");
    tagStore.upsert("abc", { genre: "ambient", mood: "calm" }, "manual");
    tagStore.rate("abc", "web:u1", 5);
    const res = await request(app).get("/tracks/abc/tags");
    expect(res.status).toBe(200);
    expect(res.body.tags.genre).toBe("ambient");
    expect(res.body.rating.count).toBeGreaterThan(0);
  });
});

describe("PATCH /tracks/:id/tags", () => {
  it("admin can set selection tags and the bumper flag", async () => {
    const { app, tagStore } = build("admin");
    const res = await request(app)
      .patch("/tracks/abc/tags")
      .send({ genre: " synthwave ", bpm: "120", bumper: true, bumperKind: "id" });
    expect(res.status).toBe(200);
    expect(tagStore.get("abc")).toMatchObject({
      genre: "synthwave",
      bpm: 120,
      bumper: true,
      source: "manual",
    });
    expect(tagStore.isBumper("abc")).toBe(true);
  });

  it("rejects a non-admin without canEditTags", async () => {
    const { app } = build("member");
    expect((await request(app).patch("/tracks/abc/tags").send({ genre: "x" })).status).toBe(403);
  });

  it("allows a member when canEditTags (radio.tags / @dj) returns true", async () => {
    const { app, tagStore } = build("member", { canEditTags: async () => true });
    const res = await request(app).patch("/tracks/abc/tags").send({ genre: "ambient" });
    expect(res.status).toBe(200);
    expect(tagStore.get("abc")?.genre).toBe("ambient");
  });

  it("still rejects a member when canEditTags returns false", async () => {
    const { app } = build("member", { canEditTags: async () => false });
    expect((await request(app).patch("/tracks/abc/tags").send({ genre: "x" })).status).toBe(403);
  });

  it("ignores unknown/garbage fields", async () => {
    const { app, tagStore } = build("admin");
    await request(app)
      .patch("/tracks/abc/tags")
      .send({ bpm: "not-a-number", evil: "x", genre: "ambient" });
    expect(tagStore.get("abc")).toMatchObject({ genre: "ambient", bpm: undefined });
  });
});

describe("POST/DELETE /tracks/:id/rating", () => {
  it("any signed-in user can rate; the web user is the rater", async () => {
    const { app, tagStore } = build("member");
    const res = await request(app).post("/tracks/song/rating").send({ stars: 4 });
    expect(res.status).toBe(200);
    expect(res.body.rating).toEqual({ avg: 4, count: 1 });
    expect(tagStore.getRating("song")).toEqual({ avg: 4, count: 1 });
  });

  it("rejects out-of-range stars", async () => {
    const { app } = build("member");
    expect((await request(app).post("/tracks/song/rating").send({ stars: 9 })).status).toBe(400);
  });

  it("DELETE removes the caller's rating", async () => {
    const { app, tagStore } = build("member");
    await request(app).post("/tracks/song/rating").send({ stars: 5 });
    const res = await request(app).delete("/tracks/song/rating");
    expect(res.body.removed).toBe(true);
    expect(tagStore.getRating("song")).toEqual({ avg: 0, count: 0 });
  });
});
