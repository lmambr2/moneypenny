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
    q.playAt(1);
    expect(findQueueIndexByQuery(q, "david guetta")).toBeNull();
  });
});

describe("!skip / !next (bare advance only)", () => {
  // Never refuse with "!skip / !next only advance… !jump …" — that self-echoed.
  // Never jump/search on skip args either (that's !jump / !playnext).
  it("!next with args only advances (ignores query)", async () => {
    const queue = new PlayQueue();
    queue.add(song("1", "Hello", "Adele"));
    queue.add(song("2", "Titanium", "David Guetta"));
    queue.play(); // on Adele
    const resolveAndPlay = vi.fn(async () => true);
    const playNext = vi.fn(async () => {
      queue.next();
    });
    const ex = new CommandExecutor({
      playback: { clearUserPause: vi.fn(), resolveAndPlay },
      player: { resetFailures: vi.fn() },
      queue,
      config: { commandPrefix: "!" },
      profileManager: {},
      tsClient: {},
      isConnected: () => true,
      playNext,
      getProvider: vi.fn(),
    } as unknown as CommandExecutorDeps);

    const out = await ex.execute({
      name: "next",
      args: "titanium",
      rawArgs: ["titanium"],
      flags: new Set(),
    });
    expect(playNext).toHaveBeenCalledOnce();
    expect(resolveAndPlay).not.toHaveBeenCalled();
    expect(out?.startsWith("!")).toBe(false);
    expect(out).not.toMatch(/only advance the queue/i);
  });

  it("!skip ella while Ella is NP advances (does not re-search or usage-spam)", async () => {
    const queue = new PlayQueue();
    queue.add(song("ella-1", "Choosin Texas", "Ella Langley"));
    queue.add(song("other", "Something Else", "Other Artist"));
    queue.play(); // Ella NP
    const searchFirst = vi.fn(async () => ({
      provider: { platform: "youtube" as const },
      song: song("ella-2", "Choosin Texas", "Ella Langley"),
    }));
    const resolveAndPlay = vi.fn(async () => true);
    const playNext = vi.fn(async () => {
      queue.next();
    });
    const ex = new CommandExecutor({
      playback: { clearUserPause: vi.fn(), resolveAndPlay, searchFirst },
      player: { resetFailures: vi.fn() },
      queue,
      config: { commandPrefix: "!" },
      profileManager: {},
      tsClient: {},
      isConnected: () => true,
      playNext,
      getProvider: vi.fn(),
    } as unknown as CommandExecutorDeps);

    const out = await ex.execute({
      name: "skip",
      args: "ella",
      rawArgs: ["ella"],
      flags: new Set(),
    });
    expect(searchFirst).not.toHaveBeenCalled();
    expect(playNext).toHaveBeenCalled();
    expect(out).toMatch(/Skipped/i);
    expect(out).not.toMatch(/only advance the queue/i);
    expect(out?.startsWith("!")).toBe(false);
    expect(queue.current()?.name).toBe("Something Else");
  });

  it("plain !skip uses the radio boundary path", async () => {
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

    const out = await ex.execute({ name: "skip", args: "", rawArgs: [], flags: new Set() });
    expect(onTrackBoundary).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/Skipped — now playing: Next Song/i);
  });
});

describe("!jump / !go", () => {
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
      name: "jump",
      args: "titanium",
      rawArgs: ["titanium"],
      flags: new Set(),
    });
    expect(out).toMatch(/Jumped to: Titanium/i);
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
      name: "go",
      args: "titanium",
      rawArgs: ["titanium"],
      flags: new Set(),
    });
    expect(out).toMatch(/Now playing: Titanium/i);
    expect(queue.current()?.name).toBe("Titanium");
    expect(searchFirst).toHaveBeenCalledTimes(1);
    expect(resolveAndPlay).toHaveBeenCalledTimes(1);
  });

  it("requires a query", async () => {
    const ex = new CommandExecutor({
      playback: { clearUserPause: vi.fn() },
      player: {},
      queue: new PlayQueue(),
      config: { commandPrefix: "!" },
      profileManager: {},
      tsClient: {},
      isConnected: () => true,
      playNext: vi.fn(),
      getProvider: vi.fn(),
    } as unknown as CommandExecutorDeps);
    const out = await ex.execute({ name: "jump", args: "", rawArgs: [], flags: new Set() });
    expect(out).toMatch(/Usage: !jump/);
  });
});
