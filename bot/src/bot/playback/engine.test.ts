import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlaybackEngine } from "./engine.js";
import { LocalProvider } from "../../music/local.js";
import { YtLibrary } from "../../music/ytlibrary.js";
import Database from "better-sqlite3";
import { DEFAULT_DEMO_VIDEO_ID } from "../../music/youtube.js";
import { PlayQueue } from "../../audio/queue.js";

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
      getSongUrl: vi.fn().mockResolvedValue("http://stream.example/audio"),
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
});