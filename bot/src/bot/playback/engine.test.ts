import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlayQueue } from "../../audio/queue.js";
import { LocalProvider } from "../../music/local.js";
import { DEFAULT_DEMO_VIDEO_ID, DEFAULT_DEMO_VIDEO_URL } from "../../music/youtube.js";
import { YtLibrary } from "../../music/ytlibrary.js";
import { PlaybackEngine } from "./engine.js";

function fakeLogger() {
  const l: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  l.child = () => l;
  return l;
}

describe("PlaybackEngine demo / YouTube local preference", () => {
  let dir: string;
  let local: LocalProvider;
  let ytLibrary: YtLibrary;
  let engine: PlaybackEngine;
  let play: ReturnType<typeof vi.fn>;
  let youtubeSearch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "playback-engine-"));
    const ytDir = join(dir, "youtube");
    mkdirSync(ytDir, { recursive: true });
    writeFileSync(join(ytDir, `Artist - Choosin Texas [${DEFAULT_DEMO_VIDEO_ID}].mp3`), "fake");

    local = new LocalProvider({ musicDir: dir });
    await local.refresh();

    const db = new Database(":memory:");
    ytLibrary = new YtLibrary({
      db,
      musicDir: dir,
      download: vi.fn(),
      refresh: () => local.refresh(),
    });

    play = vi.fn();
    const queue = new PlayQueue();
    youtubeSearch = vi.fn();
    const youtube = {
      platform: "youtube" as const,
      search: youtubeSearch,
      // Public host so assertSafePlaybackTarget (DNS rebinding gate) can pass online.
      getSongUrl: vi.fn().mockResolvedValue("https://example.com/audio.ogg"),
    };

    engine = new PlaybackEngine({
      botId: "b1",
      player: { play, resetFailures: vi.fn(), getState: () => "idle" } as any,
      queue,
      localProvider: local,
      youtubeProvider: youtube as any,
      streamProvider: { platform: "stream" } as any,
      ytLibrary,
      database: { addPlayHistory: vi.fn() } as any,
      config: { youtubeSaveEnabled: false } as any,
      profileManager: { onSongChange: vi.fn().mockResolvedValue(undefined) } as any,
      logger: fakeLogger(),
      events: { emit: vi.fn() },
      isConnected: () => true,
      isAdvancing: () => false,
      setAdvancing: vi.fn(),
    });
  });

  it("playDemoTrack uses local platform when the demo file is in the library", async () => {
    const msg = await engine.playDemoTrack();
    expect(msg).toContain("(local)");
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.calls[0][0]).toContain(DEFAULT_DEMO_VIDEO_ID);
    expect(youtubeSearch).not.toHaveBeenCalled();
  });

  it("resolveYoutubeLocalPath finds yt save dir files", async () => {
    const p = await engine.resolveYoutubeLocalPath(DEFAULT_DEMO_VIDEO_ID);
    expect(p).toContain(`[${DEFAULT_DEMO_VIDEO_ID}]`);
  });

  it("playDemoTrack falls back to YouTube when the local copy cannot be resolved", async () => {
    vi.spyOn(local, "getSongUrl").mockResolvedValue(null);
    youtubeSearch.mockResolvedValue({
      songs: [
        { id: DEFAULT_DEMO_VIDEO_ID, name: "Demo", artist: "Artist", album: "", duration: 60 },
      ],
      playlists: [],
      albums: [],
    });

    const msg = await engine.playDemoTrack();
    expect(msg).toContain("Now playing");
    // Genre policy pulls a small candidate window (default ban list → limit 8).
    expect(youtubeSearch).toHaveBeenCalledWith(DEFAULT_DEMO_VIDEO_URL, 16);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("resolveAndPlay refuses private SSRF targets at the final safety gate", async () => {
    const streamGetUrl = vi.fn().mockResolvedValue("http://127.0.0.1:6333/collections");
    (engine as any).opts.streamProvider = {
      platform: "stream",
      getSongUrl: streamGetUrl,
    };
    const queue = (engine as any).opts.queue as PlayQueue;
    queue.clear();
    queue.add({
      id: "http://127.0.0.1:6333/collections",
      name: "evil",
      artist: "x",
      album: "",
      duration: 0,
      coverUrl: "",
      platform: "stream",
    });
    queue.play();
    const ok = await engine.resolveAndPlay(queue.current()!);
    expect(ok).toBe(false);
    expect(play).not.toHaveBeenCalled();
    expect(streamGetUrl).toHaveBeenCalled();
  });

  it("resolveAndPlay skips YouTube full-album titles", async () => {
    const getSongUrl = vi.fn().mockResolvedValue("https://example.com/audio.ogg");
    (engine as any).opts.youtubeProvider.getSongUrl = getSongUrl;
    const queue = (engine as any).opts.queue as PlayQueue;
    queue.clear();
    queue.add({
      id: "dQw4w9WgXcQ",
      name: "Artist - Greatest Hits (Full Album)",
      artist: "Artist",
      album: "YouTube",
      duration: 7200,
      coverUrl: "",
      platform: "youtube",
    });
    queue.play();
    const ok = await engine.resolveAndPlay(queue.current()!);
    expect(ok).toBe(false);
    expect(play).not.toHaveBeenCalled();
    expect(getSongUrl).not.toHaveBeenCalled();
  });

  it("resolveAndPlay skips YouTube tracks longer than 15 minutes", async () => {
    const getSongUrl = vi.fn().mockResolvedValue("https://example.com/audio.ogg");
    (engine as any).opts.youtubeProvider.getSongUrl = getSongUrl;
    const queue = (engine as any).opts.queue as PlayQueue;
    queue.clear();
    queue.add({
      id: "longTrackId1",
      name: "Ambient Mix Hour 1",
      artist: "DJ",
      album: "YouTube",
      duration: 901,
      coverUrl: "",
      platform: "youtube",
    });
    queue.play();
    const ok = await engine.resolveAndPlay(queue.current()!);
    expect(ok).toBe(false);
    expect(play).not.toHaveBeenCalled();
    expect(getSongUrl).not.toHaveBeenCalled();
  });
});
