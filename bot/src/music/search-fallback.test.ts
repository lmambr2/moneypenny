import { describe, expect, it, vi } from "vitest";
import type { MusicProvider, Song } from "./provider.js";
import {
  playCandidateRank,
  refinedPlayQueries,
  searchFirstWithFallback,
} from "./search-fallback.js";

const song = (id: string, platform: Song["platform"], duration = 180): Song => ({
  id,
  name: id,
  artist: "a",
  album: "",
  duration,
  coverUrl: "",
  platform,
});

function provider(songs: Song[] | ((q: string) => Song[])): MusicProvider {
  const search = vi.fn(async (q: string) => ({
    songs: typeof songs === "function" ? songs(q) : songs,
  }));
  return { search } as unknown as MusicProvider;
}

describe("searchFirstWithFallback", () => {
  it("returns the primary hit and never touches the fallback when primary matches", async () => {
    const primary = provider([song("local-1", "local")]);
    const fallback = provider([song("yt-1", "youtube")]);
    const out = await searchFirstWithFallback(primary, "q", 1, fallback);
    expect(out?.song.id).toBe("local-1");
    expect(out?.provider).toBe(primary);
    expect(fallback.search).not.toHaveBeenCalled();
  });

  it("falls back to YouTube when the primary (local) is empty — the bare !play fix", async () => {
    const primary = provider([]);
    const fallback = provider([song("yt-1", "youtube")]);
    const out = await searchFirstWithFallback(primary, "q", 1, fallback, []);
    expect(out?.song.id).toBe("yt-1");
    expect(out?.provider).toBe(fallback);
    expect(fallback.search).toHaveBeenCalledWith("q", expect.any(Number));
  });

  it("skips genre-blocked hits and takes the next candidate", async () => {
    const primary = provider([
      { ...song("rap-1", "local"), name: "Rap Battle Live" },
      { ...song("ok-1", "local"), name: "Yacht Rock Forever" },
    ]);
    const out = await searchFirstWithFallback(primary, "q", 1, undefined, undefined);
    expect(out?.song.id).toBe("ok-1");
  });

  it("returns null when primary is empty and no fallback is allowed (e.g. -l forced)", async () => {
    const primary = provider([]);
    const out = await searchFirstWithFallback(primary, "q", 1, undefined);
    expect(out).toBeNull();
  });

  it("returns null when both primary and fallback are empty", async () => {
    const out = await searchFirstWithFallback(provider([]), "q", 1, provider([]));
    expect(out).toBeNull();
  });

  it("skips blacklisted hits and takes the next candidate", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { PlaybackBlacklist } = await import("./playback-blacklist.js");
    const bl = new PlaybackBlacklist({ db: new Database(":memory:") });
    bl.add({ trackKey: "banned" });
    const primary = provider([song("banned", "local"), song("ok", "local")]);
    const out = await searchFirstWithFallback(primary, "q", 1, undefined, [], bl);
    expect(out?.song.id).toBe("ok");
  });

  it("retries song-biased queries when genre search is all multi-hour dumps", async () => {
    const hourDump = {
      ...song("dump", "youtube", 4 * 3600),
      name: "Smooth Jazz Ambience 4 Hours",
    };
    const realTrack = {
      ...song("real", "youtube", 240),
      name: "Take Five - Dave Brubeck",
    };
    const primary = provider([]);
    const fallback = provider((q) => (q.includes("official audio") ? [realTrack] : [hourDump]));
    const out = await searchFirstWithFallback(primary, "jazz", 1, fallback, []);
    expect(out?.song.id).toBe("real");
    expect(fallback.search).toHaveBeenCalledWith("jazz official audio", expect.any(Number));
  });

  it("prefers song-length tracks over long-but-allowed mixes", async () => {
    const longish = { ...song("long", "youtube", 800), name: "Top 100 Mix" };
    const short = { ...song("short", "youtube", 200), name: "Single Song" };
    const primary = provider([longish, short]);
    const out = await searchFirstWithFallback(primary, "rock", 1, undefined, []);
    expect(out?.song.id).toBe("short");
  });
});

describe("refinedPlayQueries / playCandidateRank", () => {
  it("suggests official audio / song / topic for short genre queries", () => {
    expect(refinedPlayQueries("jazz")).toEqual(["jazz official audio", "jazz song", "jazz topic"]);
    expect(refinedPlayQueries("https://youtube.com/watch?v=x")).toEqual([]);
  });

  it("ranks preferred durations first", () => {
    expect(playCandidateRank(song("a", "youtube", 200))).toBe(0);
    expect(playCandidateRank(song("b", "youtube", 800))).toBe(1);
    expect(playCandidateRank(song("c", "youtube", 0))).toBe(2);
  });
});
