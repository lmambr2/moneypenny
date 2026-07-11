import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { filterNotBlacklisted, PlaybackBlacklist } from "./playback-blacklist.js";
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
});
