import { describe, it, expect, vi } from "vitest";
import { searchFirstWithFallback } from "./search-fallback.js";
import type { MusicProvider, Song } from "./provider.js";

const song = (id: string, platform: Song["platform"]): Song => ({
  id, name: id, artist: "a", album: "", duration: 1, coverUrl: "", platform,
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
    const out = await searchFirstWithFallback(primary, "q", 1, fallback);
    expect(out?.song.id).toBe("yt-1");
    expect(out?.provider).toBe(fallback);
    expect(fallback.search).toHaveBeenCalledWith("q", 1);
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
});
