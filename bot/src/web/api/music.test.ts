import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { MusicProvider } from "../../music/provider.js";
import { createMusicRouter } from "./music.js";

function stubProvider(platform: MusicProvider["platform"]): MusicProvider {
  return {
    platform,
    search: vi.fn(async () => ({
      songs: [
        { id: "1", name: platform, artist: "A", album: "", duration: 0, coverUrl: "", platform },
      ],
      playlists: [],
      albums: [],
    })),
    getSongUrl: async () => null,
    setQuality: () => {},
    getQuality: () => "default",
    getSongDetail: async () => null,
    getPlaylistSongs: async () => [],
    getRecommendPlaylists: async () => [],
    getAlbumSongs: async () => [],
    getLyrics: async () => [],
    getAuthStatus: async () => ({ loggedIn: true }),
  };
}

describe("music router", () => {
  function build() {
    const local = stubProvider("local");
    const youtube = stubProvider("youtube");
    const stream = stubProvider("stream");
    const a = express();
    a.use(createMusicRouter(local, youtube, stream, console as any));
    return { app: a, local, youtube, stream };
  }

  it("routes platform=stream to the stream provider", async () => {
    const { app, stream, youtube } = build();
    const res = await request(app)
      .get("/search")
      .query({ q: "http://example.com/radio.mp3", platform: "stream" });
    expect(res.status).toBe(200);
    expect(res.body.songs[0].name).toBe("stream");
    expect(stream.search).toHaveBeenCalled();
    expect(youtube.search).not.toHaveBeenCalled();
  });

  it("caps search limit at 50", async () => {
    const { app, youtube } = build();
    await request(app).get("/search").query({ q: "x", platform: "youtube", limit: "9999" });
    expect(youtube.search).toHaveBeenCalledWith("x", 50);
  });

  it("allows empty q for local platform (library browse)", async () => {
    const { app, local, youtube } = build();
    const res = await request(app).get("/search").query({ q: "", platform: "local", limit: "20" });
    expect(res.status).toBe(200);
    expect(local.search).toHaveBeenCalledWith("", 20);
    expect(youtube.search).not.toHaveBeenCalled();
  });

  it("rejects empty q for youtube search", async () => {
    const { app } = build();
    const res = await request(app).get("/search").query({ q: "", platform: "youtube" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("GET /library lists local tracks with a high limit", async () => {
    const { app, local } = build();
    const res = await request(app).get("/library").query({ limit: "100" });
    expect(res.status).toBe(200);
    expect(local.search).toHaveBeenCalledWith("", 100);
    expect(res.body.songs).toHaveLength(1);
  });

  it("DELETE /tracks/:id admin deletes via deleteSong", async () => {
    const local = stubProvider("local");
    local.deleteSong = vi.fn(async () => ({ deleted: true as const, name: "gone" }));
    const app = express();
    app.use((req, _res, next) => {
      (req as any).user = { id: "a1", role: "admin", username: "admin" };
      next();
    });
    app.use(
      createMusicRouter(local, stubProvider("youtube"), stubProvider("stream"), console as any),
    );

    const res = await request(app).delete("/tracks/abc123");
    expect(res.status).toBe(200);
    expect(local.deleteSong).toHaveBeenCalledWith("abc123");
    expect(res.body).toMatchObject({ success: true, deleted: true, name: "gone" });
  });

  it("DELETE /tracks/:id rejects non-admin", async () => {
    const local = stubProvider("local");
    local.deleteSong = vi.fn(async () => ({ deleted: true as const, name: "x" }));
    const app = express();
    app.use((req, _res, next) => {
      (req as any).user = { id: "m1", role: "member", username: "mem" };
      next();
    });
    app.use(
      createMusicRouter(local, stubProvider("youtube"), stubProvider("stream"), console as any),
    );
    expect((await request(app).delete("/tracks/abc123")).status).toBe(403);
    expect(local.deleteSong).not.toHaveBeenCalled();
  });

  it("POST/GET/DELETE /blacklist admin manages playback bans", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { PlaybackBlacklist } = await import("../../music/playback-blacklist.js");
    const bl = new PlaybackBlacklist({ db: new Database(":memory:") });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: "a1", role: "admin", username: "admin" };
      next();
    });
    app.use(
      createMusicRouter(
        stubProvider("local"),
        stubProvider("youtube"),
        stubProvider("stream"),
        console as any,
        { playbackBlacklist: bl },
      ),
    );

    const add = await request(app)
      .post("/blacklist")
      .send({ id: "song1", platform: "local", name: "Nope", artist: "X" });
    expect(add.status).toBe(200);
    expect(add.body.entry.trackKey).toBe("song1");

    const list = await request(app).get("/blacklist");
    expect(list.status).toBe(200);
    expect(list.body.keys).toContain("song1");

    const del = await request(app).delete("/blacklist/song1");
    expect(del.status).toBe(200);
    expect(bl.hasKey("song1")).toBe(false);
  });

  it("POST /blacklist rejects non-admin", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { PlaybackBlacklist } = await import("../../music/playback-blacklist.js");
    const bl = new PlaybackBlacklist({ db: new Database(":memory:") });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: "m1", role: "member", username: "mem" };
      next();
    });
    app.use(
      createMusicRouter(
        stubProvider("local"),
        stubProvider("youtube"),
        stubProvider("stream"),
        console as any,
        { playbackBlacklist: bl },
      ),
    );
    expect((await request(app).post("/blacklist").send({ id: "x" })).status).toBe(403);
  });
});
