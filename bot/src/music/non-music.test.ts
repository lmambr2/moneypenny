import { describe, expect, it } from "vitest";
import { classifyYtDlpMusicMeta, isNonMusicContent, shouldBlockAsNonMusic } from "./non-music.js";
import { shouldBlockYoutubeSong } from "./youtube.js";

describe("classifyYtDlpMusicMeta", () => {
  it("treats YouTube Music category as music", () => {
    expect(classifyYtDlpMusicMeta({ categories: ["Music"] })).toBe("music");
    expect(classifyYtDlpMusicMeta({ categories: ["Music", "Entertainment"] })).toBe("music");
  });

  it("treats News / Education / Gaming as non-music", () => {
    expect(classifyYtDlpMusicMeta({ categories: ["News & Politics"] })).toBe("nonmusic");
    expect(classifyYtDlpMusicMeta({ categories: ["Education"] })).toBe("nonmusic");
    expect(classifyYtDlpMusicMeta({ categories: ["Gaming"] })).toBe("nonmusic");
  });

  it("treats structured track/album fields as music", () => {
    expect(
      classifyYtDlpMusicMeta({
        track: "Smooth Operator",
        album: "Diamond Life",
        album_artist: "Sade",
      }),
    ).toBe("music");
  });

  it("returns unknown when metadata is sparse", () => {
    expect(classifyYtDlpMusicMeta({})).toBe("unknown");
    expect(classifyYtDlpMusicMeta({ title: "Something" })).toBe("unknown");
  });
});

describe("shouldBlockAsNonMusic (meta + title)", () => {
  it("blocks Education-category docs even with a bland title", () => {
    expect(
      shouldBlockAsNonMusic(
        { name: "The Secret Files", artist: "SomeChannel" },
        { categories: ["Education"] },
      ),
    ).toBe(true);
  });

  it("allows Music-category tracks", () => {
    expect(
      shouldBlockAsNonMusic(
        { name: "Night Drive", artist: "Chromatics" },
        { categories: ["Music"] },
      ),
    ).toBe(false);
  });

  it("still blocks hard non-music titles even if mis-tagged Music", () => {
    expect(
      shouldBlockAsNonMusic(
        { name: "WW2 Full Documentary", artist: "HistChan" },
        { categories: ["Music"] },
      ),
    ).toBe(true);
  });

  it("falls back to title when meta is unknown", () => {
    expect(shouldBlockAsNonMusic({ name: "Joe Rogan Full Podcast #12", artist: "JRE" }, null)).toBe(
      true,
    );
    expect(shouldBlockAsNonMusic({ name: "Bohemian Rhapsody", artist: "Queen" }, null)).toBe(false);
  });
});

describe("isNonMusicContent title fallback", () => {
  it("blocks documentaries and allows normal music", () => {
    expect(
      isNonMusicContent({
        name: "The Secret History — Full Documentary",
        artist: "History Channel",
      }),
    ).toBe(true);
    expect(isNonMusicContent({ name: "Bohemian Rhapsody", artist: "Queen" })).toBe(false);
  });

  it("blocks numbered TV/web episodes (auto-DJ seed junk)", () => {
    expect(isNonMusicContent({ name: "Yacht Rock Episode 1", artist: "JD Ryznar" })).toBe(true);
    expect(isNonMusicContent({ name: "Something S01E03 Full", artist: "Netflix" })).toBe(true);
    expect(isNonMusicContent({ name: "Cool Band - Live at Red Rocks", artist: "Cool Band" })).toBe(
      false,
    );
  });

  it("blocks the Beato yacht-rock essay that pollutes yacht rock seeds", () => {
    expect(isNonMusicContent({ name: '"Yacht Rock" Is Bullsh*t', artist: "Rick Beato" })).toBe(
      true,
    );
    expect(isNonMusicContent({ name: "Yacht Rock Is Bullshit", artist: "Rick Beato" })).toBe(true);
  });
});

describe("classifyMusicCommandResult", () => {
  it("classifies success and failure replies", async () => {
    const { classifyMusicCommandResult } = await import("../control/router.js");
    expect(classifyMusicCommandResult("Now playing: A - B")).toMatchObject({
      ok: true,
      reason: "ok",
    });
    expect(classifyMusicCommandResult("No results found for: x")).toMatchObject({
      ok: false,
      reason: "noresults",
    });
    expect(classifyMusicCommandResult("You don't have permission to use 'play'.")).toMatchObject({
      denied: true,
      reason: "permission",
    });
    expect(
      classifyMusicCommandResult(
        "Only Chairman or server admin can skip or replace the !test demo track.",
      ),
    ).toMatchObject({ denied: true, reason: "demo_protect" });
  });
});

describe("shouldBlockYoutubeSong with ytMeta", () => {
  it("uses categories from yt-dlp", () => {
    expect(
      shouldBlockYoutubeSong({
        title: "Random Title",
        artist: "NewsNet",
        duration: 400,
        ytMeta: { categories: ["News & Politics"] },
      }),
    ).toBe(true);
    expect(
      shouldBlockYoutubeSong({
        title: "Cool Track",
        artist: "Band",
        duration: 200,
        ytMeta: { categories: ["Music"] },
      }),
    ).toBe(false);
  });

  it("explicit URL policy allows Gaming-category songs (user intent)", () => {
    const gamingArt = {
      title: "Jackknife Klorfson",
      artist: "solereavr",
      duration: 220,
      ytMeta: { categories: ["Gaming"] as string[] },
    };
    expect(shouldBlockYoutubeSong(gamingArt)).toBe(true);
    expect(shouldBlockYoutubeSong({ ...gamingArt, policy: "explicit" })).toBe(false);
    // Still refuse multi-hour dumps even for explicit URLs.
    expect(
      shouldBlockYoutubeSong({
        title: "Full Album",
        duration: 4000,
        policy: "explicit",
      }),
    ).toBe(true);
  });
});
