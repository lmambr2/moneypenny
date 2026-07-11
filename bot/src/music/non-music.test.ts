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
});
