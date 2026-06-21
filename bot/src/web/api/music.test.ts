import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createMusicRouter } from "./music.js";
import type { MusicProvider } from "../../music/provider.js";

function stubProvider(platform: MusicProvider["platform"]): MusicProvider {
  return {
    platform,
    search: vi.fn(async () => ({ songs: [{ id: "1", name: platform, artist: "A", album: "", duration: 0, coverUrl: "", platform }], playlists: [], albums: [] })),
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
    const res = await request(app).get("/search").query({ q: "http://example.com/radio.mp3", platform: "stream" });
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
});