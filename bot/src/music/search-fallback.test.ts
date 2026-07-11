import { describe, expect, it, vi } from "vitest";
import type { MusicProvider, Song } from "./provider.js";
import { searchFirstWithFallback } from "./search-fallback.js";

const song = (id: string, platform: Song["platform"]): Song => ({
  id,
  name: id,
  artist: "a",
  album: "",
  duration: 1,
  coverUrl: "",
  platform,
});

function provider(songs: Song[]): MusicProvider {
  return { search: vi.fn().mockResolvedValue({ songs }) } as unknown as MusicProvider;
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
    expect(fallback.search).toHaveBeenCalledWith("q", 1);
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
});
