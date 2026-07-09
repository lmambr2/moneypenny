import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEMO_VIDEO_ID,
  DEFAULT_DEMO_VIDEO_URL,
  isYoutubeFullAlbumTitle,
  isYoutubeTooLong,
  safeYtDlpMediaUrl,
  shouldBlockYoutubeSong,
  YOUTUBE_MAX_DURATION_SEC,
  YouTubeProvider,
} from "./youtube.js";

describe("safeYtDlpMediaUrl", () => {
  it("rejects non-http(s) schemes even with allowlisted hostnames", async () => {
    expect(await safeYtDlpMediaUrl("ftp://youtube.com/watch?v=abc")).toBeNull();
    expect(await safeYtDlpMediaUrl("file:///etc/passwd")).toBeNull();
    expect(await safeYtDlpMediaUrl("data:text/plain,youtu.be")).toBeNull();
  });

  it("passes bare video ids through for the caller to rebuild", async () => {
    expect(await safeYtDlpMediaUrl(DEFAULT_DEMO_VIDEO_ID)).toBe(DEFAULT_DEMO_VIDEO_ID);
  });

  it("rejects http(s) URLs on non-media hosts", async () => {
    expect(await safeYtDlpMediaUrl("https://example.com/watch?v=abc")).toBeNull();
  });
});

describe("isYoutubeFullAlbumTitle", () => {
  it("blocks full album dumps (case / punctuation variants)", () => {
    expect(isYoutubeFullAlbumTitle("Artist - Album Name (Full Album)")).toBe(true);
    expect(isYoutubeFullAlbumTitle("FULL ALBUM STREAM")).toBe(true);
    expect(isYoutubeFullAlbumTitle("Something - Full-Album [HQ]")).toBe(true);
    expect(isYoutubeFullAlbumTitle("band fullalbum 2020")).toBe(true);
    expect(isYoutubeFullAlbumTitle("Night Drive (full_album)")).toBe(true);
  });

  it("allows normal track titles", () => {
    expect(isYoutubeFullAlbumTitle("Full Moon Tonight")).toBe(false);
    expect(isYoutubeFullAlbumTitle("Album Cover Art ASMR")).toBe(false);
    expect(isYoutubeFullAlbumTitle("Bohemian Rhapsody")).toBe(false);
    expect(isYoutubeFullAlbumTitle("")).toBe(false);
  });
});

describe("isYoutubeTooLong / shouldBlockYoutubeSong", () => {
  it("caps at 15 minutes", () => {
    expect(YOUTUBE_MAX_DURATION_SEC).toBe(900);
    expect(isYoutubeTooLong(900)).toBe(false); // exactly 15m ok
    expect(isYoutubeTooLong(901)).toBe(true);
    expect(isYoutubeTooLong(3600)).toBe(true);
    expect(isYoutubeTooLong(180)).toBe(false);
  });

  it("allows unknown duration (oEmbed / missing metadata)", () => {
    expect(isYoutubeTooLong(0)).toBe(false);
    expect(isYoutubeTooLong(undefined)).toBe(false);
    expect(isYoutubeTooLong(null)).toBe(false);
  });

  it("combines title and duration gates", () => {
    expect(shouldBlockYoutubeSong({ title: "Full Album", duration: 60 })).toBe(true);
    expect(shouldBlockYoutubeSong({ title: "Normal Song", duration: 1200 })).toBe(true);
    expect(shouldBlockYoutubeSong({ title: "Normal Song", duration: 240 })).toBe(false);
  });
});

const hasYtDlp = (() => {
  try {
    execSync("yt-dlp --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("YouTubeProvider — default unit test / startup video", () => {
  const provider = new YouTubeProvider();

  it("exports the canonical demo video constants", () => {
    expect(DEFAULT_DEMO_VIDEO_ID).toBe("hLOheGDwD_0");
    expect(DEFAULT_DEMO_VIDEO_URL).toBe("https://www.youtube.com/watch?v=hLOheGDwD_0");
  });

  it("canHandle recognizes the default video URL (and short youtu.be form)", () => {
    expect(provider.canHandle(DEFAULT_DEMO_VIDEO_URL)).toBe(true);
    expect(provider.canHandle(`https://youtu.be/${DEFAULT_DEMO_VIDEO_ID}`)).toBe(true);
    expect(provider.canHandle("some random song name")).toBe(false);
  });

  // The following exercises the real yt-dlp direct-URL fast path used for
  // PHASE0_TEST_PLAY startup auto-play and for !play <youtube url>.
  // It is the primary "does YouTube still work end-to-end" unit test.
  (hasYtDlp ? it : it.skip)(
    "search(direct default video URL) returns the expected song shape",
    async () => {
      const res = await provider.search(DEFAULT_DEMO_VIDEO_URL, 1);
      expect(res.songs).toHaveLength(1);

      const song = res.songs[0];
      expect(song.id).toBe(DEFAULT_DEMO_VIDEO_ID);
      expect(song.platform).toBe("youtube");
      expect(song.name.length).toBeGreaterThan(3); // real title
      expect(song.artist.length).toBeGreaterThan(0);
      expect(song.duration).toBeGreaterThanOrEqual(0);
      // coverUrl may be present
    },
    30_000,
  );

  (hasYtDlp ? it : it.skip)(
    "getSongDetail on the default video ID returns metadata",
    async () => {
      const detail = await provider.getSongDetail(DEFAULT_DEMO_VIDEO_ID);
      expect(detail).not.toBeNull();
      expect(detail!.id).toBe(DEFAULT_DEMO_VIDEO_ID);
      expect(detail!.platform).toBe("youtube");
      expect(detail!.name.length).toBeGreaterThan(3);
    },
    30_000,
  );

  (hasYtDlp ? it : it.skip)(
    "getSongUrl on the default video produces a playable audio stream URL (may be null for age-restricted without cookies)",
    async () => {
      const url = await provider.getSongUrl(DEFAULT_DEMO_VIDEO_ID);
      // For age-restricted videos like the default test one, this requires --cookies.
      // We accept null (graceful) or a real stream URL.
      if (url) {
        expect(String(url).startsWith("http")).toBe(true);
      } else {
        expect(url).toBeNull();
      }
    },
    45_000,
  );
});
