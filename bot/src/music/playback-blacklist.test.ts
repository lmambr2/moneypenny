import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  blacklistContentKey,
  filterNotBlacklisted,
  normalizeBlacklistText,
  PlaybackBlacklist,
} from "./playback-blacklist.js";
import { DEFAULT_DEMO_VIDEO_ID } from "./youtube.js";

describe("PlaybackBlacklist", () => {
  function store() {
    return new PlaybackBlacklist({ db: new Database(":memory:"), now: () => 1_700_000_000_000 });
  }

  it("adds, lists, and removes by track key", () => {
    const bl = store();
    bl.add({ trackKey: "abc123", platform: "local", name: "Tune", artist: "A" });
    expect(bl.hasKey("abc123")).toBe(true);
    expect(bl.isBlacklisted({ id: "abc123" })).toBe(true);
    // list hides content: fingerprint keys
    expect(bl.list()).toHaveLength(1);
    expect(bl.list()[0]!.name).toBe("Tune");
    expect(bl.remove("abc123")).toBe(true);
    expect(bl.hasKey("abc123")).toBe(false);
  });

  it("matches YouTube video ids extracted from URL-form keys", () => {
    const bl = store();
    bl.add({
      trackKey: `https://www.youtube.com/watch?v=${DEFAULT_DEMO_VIDEO_ID}`,
      platform: "youtube",
      name: "Demo",
    });
    expect(bl.isBlacklisted({ id: DEFAULT_DEMO_VIDEO_ID })).toBe(true);
    expect(bl.isBlacklisted({ id: `https://youtu.be/${DEFAULT_DEMO_VIDEO_ID}` })).toBe(true);
  });

  it("matches [videoId] embedded in local track names", () => {
    const bl = store();
    bl.add({ trackKey: DEFAULT_DEMO_VIDEO_ID, platform: "youtube" });
    expect(
      bl.isBlacklisted({
        id: "sha1localopaque",
        name: `Artist - Choosin Texas [${DEFAULT_DEMO_VIDEO_ID}]`,
      }),
    ).toBe(true);
  });

  it("blocks the same title under a different platform id (local ban → YT reseed)", () => {
    const bl = store();
    bl.add({
      trackKey: "cee102bedd919fafc618743f59ce6346b0ebbb53",
      platform: "local",
      name: '"Yacht Rock" Is Bullsh*t',
      artist: "Rick Beato",
    });
    // Auto-DJ later seeds the YouTube copy with a different id
    expect(
      bl.isBlacklisted({
        id: "kEYUw2kiRfc",
        name: '"Yacht Rock" Is Bullsh*t',
        artist: "Rick Beato",
        platform: "youtube",
      } as any),
    ).toBe(true);
    // Noise in titles still matches
    expect(
      bl.isBlacklisted({
        id: "otherid12345",
        name: '"Yacht Rock" Is Bullsh*t (Official Video)',
        artist: "Rick Beato",
      }),
    ).toBe(true);
    // asterisk vs full spelling + slightly different artist field
    expect(
      bl.isBlacklisted({
        id: "kEYUw2kiRfc",
        name: "Yacht Rock Is Bullshit",
        artist: "Rick Beato - Topic",
      }),
    ).toBe(true);
  });

  it("does not cross-ban different artists with similar titles", () => {
    const bl = store();
    bl.add({
      trackKey: "icewear-local-hash",
      platform: "local",
      name: "Heavy Metal (Official Video)",
      artist: "Icewear Vezzo",
    });
    expect(
      bl.isBlacklisted({
        id: "sammy-local",
        name: "Heavy Metal",
        artist: "Sammy Hagar",
      }),
    ).toBe(false);
  });

  it("matches when local name embeds Artist - Title but YT is just Title", () => {
    const bl = store();
    bl.add({
      trackKey: "icewear-local-hash",
      platform: "local",
      name: "Icewear Vezzo -  Heavy Metal (Official Video)",
      artist: "Icewear Vezzo",
    });
    expect(
      bl.isBlacklisted({
        id: "ytVideoId12",
        name: "Heavy Metal (Official Video)",
        artist: "Icewear Vezzo",
      }),
    ).toBe(true);
  });

  it("filterNotBlacklisted drops blocked hits", () => {
    const bl = store();
    bl.add({ trackKey: "bad" });
    const kept = filterNotBlacklisted(
      [
        { id: "bad", name: "x" },
        { id: "good", name: "y" },
      ],
      bl,
    );
    expect(kept.map((s) => s.id)).toEqual(["good"]);
  });

  it("normalizeBlacklistText strips official-video noise", () => {
    expect(normalizeBlacklistText("Top 100 80's Hard Rock Songs (Official HD Music Video)")).toBe(
      "top 100 80 s hard rock songs",
    );
    expect(blacklistContentKey('"Yacht Rock" Is Bullsh*t', "Rick Beato")).toBe(
      blacklistContentKey("Yacht Rock Is Bullshit", "Rick Beato - Topic"),
    );
  });
});
