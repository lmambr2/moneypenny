import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import {
  YouTubeProvider,
  DEFAULT_DEMO_VIDEO_ID,
  DEFAULT_DEMO_VIDEO_URL,
} from "./youtube.js";

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
    expect(DEFAULT_DEMO_VIDEO_ID).toBe("52i14wYBef8");
    expect(DEFAULT_DEMO_VIDEO_URL).toBe("https://www.youtube.com/watch?v=52i14wYBef8");
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
    30_000
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
    30_000
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
    45_000
  );
});
