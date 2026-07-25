import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanExternalTrackTitle,
  isBandcampUrl,
  isSpotifyRef,
  isStreamableUrl,
  isTidalUrl,
  isXTwitterUrl,
  StreamProvider,
} from "./stream.js";

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

describe("cleanExternalTrackTitle", () => {
  it("strips Tidal/Spotify OG boilerplate", () => {
    expect(cleanExternalTrackTitle("Listen to I Am Not Afraid on TIDAL")).toBe("I Am Not Afraid");
    expect(cleanExternalTrackTitle("Song Name | Spotify")).toBe("Song Name");
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

  it("refuses private stream URLs at play time (DNS rebinding / literal gate)", async () => {
    expect(await provider.getSongUrl("http://127.0.0.1:8000/secret")).toBeNull();
    expect(await provider.getSongUrl("http://169.254.169.254/meta")).toBeNull();
    expect(await provider.getSongUrl("http://10.0.0.5/stream.mp3")).toBeNull();
    expect(await provider.getSongUrl("http://192.168.1.1/live")).toBeNull();
    expect(await provider.getSongUrl("http://stt-whisper:9000/x")).toBeNull();
  });

  it("returns public stream URLs when DNS check passes (or null fail-closed offline)", async () => {
    const streamUrl = "https://example.com/live.mp3";
    // example.com is public; if DNS is unavailable assertSafe fails closed → null.
    const got = await provider.getSongUrl(streamUrl);
    expect(got === streamUrl || got === null).toBe(true);
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubJsonGet(handler: (url: string) => unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const data = handler(String(url));
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  }

  it("resolves a Spotify ref via the bridge for metadata and playback", async () => {
    const publicStream = "https://example.com/stream/abc.ogg";
    stubJsonGet(() => ({
      streamUrl: publicStream,
      title: "Song X",
      artist: "Artist Y",
      durationSec: 200,
    }));

    const provider = new StreamProvider({ bridgeUrl: "http://bridge.local/" });
    expect(provider.canHandle("spotify:track:abc")).toBe(true);

    const res = await provider.search("spotify:track:abc");
    expect(res.songs[0]).toMatchObject({
      name: "Song X",
      artist: "Artist Y",
      duration: 200,
      platform: "stream",
    });
    expect(res.songs[0].id).toBe("spotify:track:abc");

    const url = await provider.getSongUrl("spotify:track:abc");
    expect(url).toBe(publicStream);
    expect(String(vi.mocked(fetch).mock.calls.at(-1)![0])).toContain("http://bridge.local/resolve");
    expect(String(vi.mocked(fetch).mock.calls.at(-1)![0])).toContain("uri=spotify%3Atrack%3Aabc");
  });

  it("returns empty when bridge cannot resolve (no ghost unplayable songs)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("503");
      }),
    );
    const provider = new StreamProvider({ bridgeUrl: "http://bridge.local" });
    expect((await provider.search("https://tidal.com/browse/track/1")).songs).toHaveLength(0);
  });

  it("routes Tidal and Spotify to different bridge bases", async () => {
    const publicStream = "https://example.com/stream/t.ogg";
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ streamUrl: publicStream, title: "T", artist: "A", durationSec: 100 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new StreamProvider({
      tidalBridgeUrl: "http://tidal-bridge:8081",
      spotifyBridgeUrl: "http://spotify-bridge:8082",
    });
    expect(provider.canHandle("https://tidal.com/browse/track/1")).toBe(true);
    expect(provider.canHandle("spotify:track:abc")).toBe(true);
    await provider.search("https://tidal.com/browse/track/99");
    const tidalUrl = String((fetchMock.mock.calls as unknown as Array<[string]>)[0]?.[0] ?? "");
    expect(tidalUrl).toContain("http://tidal-bridge:8081/resolve");
    fetchMock.mockClear();
    await provider.search("spotify:track:abc");
    const spotifyUrl = String((fetchMock.mock.calls as unknown as Array<[string]>)[0]?.[0] ?? "");
    expect(spotifyUrl).toContain("http://spotify-bridge:8082/resolve");
  });

  it("drops bridge streamUrl that points at private/reserved targets", async () => {
    stubJsonGet(() => ({
      streamUrl: "http://127.0.0.1:6333/collections",
      title: "x",
      artist: "y",
    }));
    const provider = new StreamProvider({ bridgeUrl: "http://bridge.local/" });
    expect(await provider.getSongUrl("spotify:track:evil")).toBeNull();
  });

  it("degrades gracefully when the bridge fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("bridge down");
      }),
    );
    const provider = new StreamProvider({ bridgeUrl: "http://bridge.local" });
    expect(await provider.getSongUrl("spotify:track:abc")).toBeNull();
    const res = await provider.search("spotify:track:abc");
    expect(res.songs).toHaveLength(0);
  });

  it("reports bridge availability via auth status", async () => {
    expect((await new StreamProvider().getAuthStatus()).loggedIn).toBe(false);
    expect((await new StreamProvider({ bridgeUrl: "http://b" }).getAuthStatus()).loggedIn).toBe(
      true,
    );
  });

  it("expands a Spotify playlist via GET /playlist on the real provider", async () => {
    stubJsonGet(() => ({
      tracks: [
        {
          uri: "spotify:track:aaa",
          title: "Track A",
          artist: "Artist A",
          durationSec: 180,
        },
        { uri: "spotify:track:bbb", title: "Track B", artist: "Artist B" },
      ],
    }));
    const provider = new StreamProvider({ bridgeUrl: "http://bridge.local" });
    const songs = await provider.getPlaylistSongs(
      "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
    );
    expect(songs).toHaveLength(2);
    expect(songs[0]).toMatchObject({
      id: "spotify:track:aaa",
      name: "Track A",
      artist: "Artist A",
      platform: "stream",
      duration: 180,
    });
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toContain("http://bridge.local/playlist");
  });

  it("returns [] when playlist bridge is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("bridge down");
      }),
    );
    const provider = new StreamProvider({ bridgeUrl: "http://bridge.local" });
    expect(await provider.getPlaylistSongs("spotify:playlist:x")).toEqual([]);
  });

  it("returns [] without a bridge (clear unavailable)", async () => {
    const provider = new StreamProvider();
    expect(await provider.getPlaylistSongs("spotify:playlist:x")).toEqual([]);
  });

  it("expands a Tidal playlist when the bridge returns tracks", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain("/playlist");
      return new Response(
        JSON.stringify({
          tracks: [
            {
              uri: "https://tidal.com/browse/track/99",
              title: "Tidal Tune",
              artist: "Artist",
              durationSec: 120,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new StreamProvider({ bridgeUrl: "http://bridge.local" });
    const songs = await provider.getPlaylistSongs(
      "https://tidal.com/browse/playlist/abc-def-12345678",
    );
    expect(songs).toHaveLength(1);
    expect(songs[0]!.name).toBe("Tidal Tune");
    expect(songs[0]!.platform).toBe("stream");
  });

  it("fails open empty when Tidal bridge returns 503 body", async () => {
    stubJsonGet(() => ({ error: "not logged in", tracks: [] }));
    const provider = new StreamProvider({ bridgeUrl: "http://bridge.local" });
    expect(await provider.getPlaylistSongs("https://tidal.com/browse/playlist/x")).toEqual([]);
  });
});
