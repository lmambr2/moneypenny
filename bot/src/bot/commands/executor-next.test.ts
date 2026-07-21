import { describe, expect, it, vi } from "vitest";
import { PlayQueue } from "../../audio/queue.js";
import type { CommandExecutorDeps } from "./executor.js";
import { CommandExecutor, findQueueIndexByQuery } from "./executor.js";

function song(
  id: string,
  name: string,
  artist = "Artist",
): {
  id: string;
  name: string;
  artist: string;
  album: string;
  platform: "youtube";
  coverUrl: string;
  duration: number;
  source: "user";
} {
  return {
    id,
    name,
    artist,
    album: "",
    platform: "youtube",
    coverUrl: "",
    duration: 180,
    source: "user",
  };
}

describe("findQueueIndexByQuery", () => {
  it("prefers upcoming matches over earlier ones", () => {
    const q = new PlayQueue();
    q.add(song("1", "Titanium", "David Guetta"));
    q.add(song("2", "Other"));
    q.add(song("3", "Titanium Remix", "Someone"));
    q.playAt(1); // now on "Other"
    expect(findQueueIndexByQuery(q, "titanium")).toBe(2);
  });

  it("matches multi-token artist + title (not the current track)", () => {
    const q = new PlayQueue();
    q.add(song("1", "Hello", "Adele"));
    q.add(song("2", "Titanium", "David Guetta"));
    q.play(); // on Adele
    expect(findQueueIndexByQuery(q, "david guetta")).toBe(1);
    // Current song is ignored so a plain re-request of now-playing does not "jump".
    q.playAt(1);
    expect(findQueueIndexByQuery(q, "david guetta")).toBeNull();
  });
});

describe("!next <query>", () => {
  it("jumps to a matching song already in the queue", async () => {
    const queue = new PlayQueue();
    queue.add(song("a", "1985", "Bowling For Soup"));
    queue.add(song("b", "Titanium", "David Guetta"));
    queue.add(song("c", "Filler"));
    queue.playAt(0);

    const resolveAndPlay = vi.fn(async () => true);
    const ex = new CommandExecutor({
      playback: {
        resolveAndPlay,
        searchFirst: vi.fn(),
        clearUserPause: vi.fn(),
      },
      player: { resetFailures: vi.fn() },
      queue,
      config: { commandPrefix: "!" },
      profileManager: {},
      tsClient: {},
      isConnected: () => true,
      playNext: vi.fn(),
      getProvider: vi.fn(),
    } as unknown as CommandExecutorDeps);

    const out = await ex.execute({
      name: "next",
      args: "titanium",
      rawArgs: ["titanium"],
      flags: new Set(),
    });
    expect(out).toMatch(/Skipped to: Titanium/i);
    expect(queue.current()?.id).toBe("b");
    expect(resolveAndPlay).toHaveBeenCalledTimes(1);
  });

  it("searches and starts the song when not in queue", async () => {
    const queue = new PlayQueue();
    queue.add(song("a", "1985", "Bowling For Soup"));
    queue.playAt(0);

    const found = song("yt-ti", "Titanium", "David Guetta ft. Sia");
    const searchFirst = vi.fn(async () => ({
      provider: { platform: "youtube" as const },
      song: found,
    }));
    const resolveAndPlay = vi.fn(async () => true);

    const ex = new CommandExecutor({
      playback: {
        resolveAndPlay,
        searchFirst,
        clearUserPause: vi.fn(),
      },
      player: { resetFailures: vi.fn() },
      queue,
      config: { commandPrefix: "!" },
      profileManager: {},
      tsClient: {},
      isConnected: () => true,
      playNext: vi.fn(),
      getProvider: vi.fn(),
    } as unknown as CommandExecutorDeps);

    const out = await ex.execute({
      name: "next",
      args: "titanium",
      rawArgs: ["titanium"],
      flags: new Set(),
    });
    expect(out).toMatch(/Now playing: Titanium/i);
    expect(queue.current()?.name).toBe("Titanium");
    expect(searchFirst).toHaveBeenCalledTimes(1);
    expect(resolveAndPlay).toHaveBeenCalledTimes(1);
  });

  it("plain !next still uses the radio boundary path", async () => {
    const onTrackBoundary = vi.fn(async () => "advanced" as const);
    const ex = new CommandExecutor({
      playback: { clearUserPause: vi.fn() },
      player: {},
      queue: { current: () => song("n", "Next Song", "A") },
      config: { commandPrefix: "!" },
      profileManager: {},
      tsClient: {},
      isConnected: () => true,
      playNext: vi.fn(),
      getProvider: vi.fn(),
      radio: {
        onTrackBoundary,
        cueBumper: vi.fn(),
        cueSay: vi.fn(),
        skipBumper: vi.fn(),
        status: () => ({ songsUntilBumper: null, cuePending: false, skipNextPending: false }),
      },
    } as unknown as CommandExecutorDeps);

    const out = await ex.execute({ name: "next", args: "", rawArgs: [], flags: new Set() });
    expect(onTrackBoundary).toHaveBeenCalledTimes(1);
    expect(out).toContain("Now playing: Next Song");
  });
});
