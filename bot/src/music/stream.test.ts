import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { StreamProvider, isStreamableUrl, isSpotifyRef, isXTwitterUrl, isBandcampUrl, isTidalUrl } from "./stream.js";

vi.mock("axios");

describe("isBandcampUrl / isTidalUrl", () => {
  it("matches Bandcamp + Tidal hosts", () => {
    expect(isBandcampUrl("https://artist.bandcamp.com/track/song")).toBe(true);
    expect(isTidalUrl("https://tidal.com/browse/track/12345")).toBe(true);
    expect(isTidalUrl("https://listen.tidal.com/track/12345")).toBe(true);
    expect(isBandcampUrl("https://example.com")).toBe(false);
    expect(isTidalUrl("https://example.com")).toBe(false);
  });
  it("isStreamableUrl excludes Bandcamp/Tidal/Spotify (they have their own handling)", () => {
    expect(isStreamableUrl("https://artist.bandcamp.com/track/song")).toBe(false);
    expect(isStreamableUrl("https://tidal.com/browse/track/1")).toBe(false);
    expect(isStreamableUrl("https://open.spotify.com/track/abc")).toBe(false);
  });
});

describe("isXTwitterUrl", () => {
  it("matches x.com / twitter.com / t.co", () => {
    expect(isXTwitterUrl("https://x.com/user/status/123")).toBe(true);
    expect(isXTwitterUrl("https://twitter.com/user/status/123")).toBe(true);
    expect(isXTwitterUrl("https://t.co/abc")).toBe(true);
  });
  it("does not match YouTube or other sites", () => {
    expect(isXTwitterUrl("https://www.youtube.com/watch?v=abc")).toBe(false);
    expect(isXTwitterUrl("https://example.com/x.com")).toBe(false);
    expect(isXTwitterUrl("not a url")).toBe(false);
  });
});

describe("isStreamableUrl", () => {
  it("accepts non-YouTube http(s) URLs", () => {
    expect(isStreamableUrl("http://stream.example.com/live")).toBe(true);
    expect(isStreamableUrl("https://icecast.example.org:8000/radio.mp3")).toBe(true);
  });
  it("rejects YouTube + X/Twitter URLs (the yt-dlp provider handles those)", () => {
    expect(isStreamableUrl("https://www.youtube.com/watch?v=abc")).toBe(false);
    expect(isStreamableUrl("https://youtu.be/abc")).toBe(false);
    expect(isStreamableUrl("https://x.com/user/status/123")).toBe(false);
    expect(isStreamableUrl("https://twitter.com/user/status/123")).toBe(false);
  });
  it("rejects non-URLs and non-http schemes", () => {
    expect(isStreamableUrl("just a song name")).toBe(false);
    expect(isStreamableUrl("ftp://x/y")).toBe(false);
    expect(isStreamableUrl("spotify:track:abc")).toBe(false);
  });

  it("rejects internal / SSRF targets", () => {
    expect(isStreamableUrl("http://qdrant:6333/collections")).toBe(false);
    expect(isStreamableUrl("http://127.0.0.1:11434/api/tags")).toBe(false);
    expect(isStreamableUrl("http://192.168.1.1/live")).toBe(false);
  });
});

describe("isSpotifyRef", () => {
  it("matches spotify URIs and open.spotify.com URLs", () => {
    expect(isSpotifyRef("spotify:track:4uLU6hMCjMI75M1A2tKUQC")).toBe(true);
    expect(isSpotifyRef("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")).toBe(true);
  });
  it("rejects other refs", () => {
    expect(isSpotifyRef("https://example.com/track/1")).toBe(false);
    expect(isSpotifyRef("track:1")).toBe(false);
  });
});

describe("StreamProvider — direct URLs", () => {
  const provider = new StreamProvider();

  it("searches a direct URL into a single stream song", async () => {
    const res = await provider.search("https://icecast.example.org:8000/radio.mp3");
    expect(res.songs).toHaveLength(1);
    expect(res.songs[0]).toMatchObject({ platform: "stream", name: "radio.mp3" });
    expect(res.songs[0].id).toBe("https://icecast.example.org:8000/radio.mp3");
  });

  it("returns the URL as the playable url", async () => {
    const url = "http://stream.example.com/live";
    expect(await provider.getSongUrl(url)).toBe(url);
  });

  it("returns empty for plain text queries", async () => {
    expect((await provider.search("some song")).songs).toHaveLength(0);
  });

  it("canHandle reflects URL/Spotify support", () => {
    expect(provider.canHandle("http://x/y")).toBe(true);
    expect(provider.canHandle("spotify:track:abc")).toBe(false); // no bridge configured
    expect(provider.canHandle("hello")).toBe(false);
  });
});

describe("StreamProvider — Spotify bridge", () => {
  const mockedGet = vi.mocked(axios.get);

  beforeEach(() => {
    mockedGet.mockReset();
  });

  it("resolves a Spotify ref via the bridge for metadata and playback", async () => {
    mockedGet.mockResolvedValue({
      data: { streamUrl: "http://bridge.local/stream/abc.ogg", title: "Song X", artist: "Artist Y", durationSec: 200 },
    } as any);

    const provider = new StreamProvider({ bridgeUrl: "http://bridge.local/" });
    expect(provider.canHandle("spotify:track:abc")).toBe(true);

    const res = await provider.search("spotify:track:abc");
    expect(res.songs[0]).toMatchObject({ name: "Song X", artist: "Artist Y", duration: 200, platform: "stream" });
    // id stays the spotify ref, re-resolved at play time
    expect(res.songs[0].id).toBe("spotify:track:abc");

    const url = await provider.getSongUrl("spotify:track:abc");
    expect(url).toBe("http://bridge.local/stream/abc.ogg");
    expect(mockedGet).toHaveBeenLastCalledWith("http://bridge.local/resolve", expect.objectContaining({ params: { uri: "spotify:track:abc" } }));
  });

  it("degrades gracefully when the bridge fails", async () => {
    mockedGet.mockRejectedValue(new Error("bridge down"));
    const provider = new StreamProvider({ bridgeUrl: "http://bridge.local" });
    expect(await provider.getSongUrl("spotify:track:abc")).toBeNull();
    // search still yields a placeholder song (so the queue isn't silently empty)
    const res = await provider.search("spotify:track:abc");
    expect(res.songs[0]).toMatchObject({ platform: "stream", artist: "Spotify" });
  });

  it("reports bridge availability via auth status", async () => {
    expect((await new StreamProvider().getAuthStatus()).loggedIn).toBe(false);
    expect((await new StreamProvider({ bridgeUrl: "http://b" }).getAuthStatus()).loggedIn).toBe(true);
  });
});
