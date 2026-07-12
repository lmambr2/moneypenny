import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { PlayQueue } from "../../audio/queue.js";
import { PlaybackBlacklist } from "../../music/playback-blacklist.js";
import type { CommandExecutorDeps } from "./executor.js";
import { CommandExecutor } from "./executor.js";

function makeDeps(opts?: { song?: { id: string; name: string; artist: string } | null }) {
  const db = new Database(":memory:");
  const bl = new PlaybackBlacklist({ db });
  const queue = new PlayQueue();
  const song = opts?.song;
  if (song) {
    queue.add({
      id: song.id,
      name: song.name,
      artist: song.artist,
      album: "",
      platform: "youtube",
      coverUrl: "",
      duration: 180,
      source: "user",
    });
    queue.play();
  }
  const playNext = vi.fn(async () => {
    const n = queue.next();
    return !!n;
  });
  const deps = {
    playback: {
      resolveAndPlay: vi.fn(async () => true),
      isDemoTestPlaying: () => false,
    },
    player: {
      stop: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      setVolume: vi.fn(),
      resetFailures: vi.fn(),
    },
    queue,
    config: { commandPrefix: "!" },
    profileManager: { onSongChange: vi.fn(async () => {}) },
    tsClient: {},
    isConnected: () => true,
    playNext,
    getProvider: vi.fn(),
    playbackBlacklist: bl,
    radio: {
      onTrackBoundary: vi.fn(async () => {
        await playNext();
        return "advanced" as const;
      }),
      cueBumper: vi.fn(),
      cueSay: vi.fn(),
      skipBumper: vi.fn(),
      status: () => ({ songsUntilBumper: null, cuePending: false, skipNextPending: false }),
    },
  } as unknown as CommandExecutorDeps;
  return { deps, bl, queue, playNext };
}

describe("!ban / !unban", () => {
  it("bans the current track and skips", async () => {
    const { deps, bl } = makeDeps({
      song: { id: "dQw4w9WgXcQ", name: "Never Gonna Give You Up", artist: "Rick" },
    });
    const ex = new CommandExecutor(deps);
    const out = await ex.execute(
      { name: "ban", args: "trash", rawArgs: ["trash"], flags: new Set() },
      { invokerName: "Lane", invokerUid: "uid1" } as any,
    );
    expect(out).toMatch(/Banned: Never Gonna Give You Up/);
    expect(bl.isBlacklisted({ id: "dQw4w9WgXcQ", name: "Never Gonna Give You Up" })).toBe(true);
    expect(bl.list()[0]?.reason).toBe("trash");
    expect(bl.list()[0]?.createdBy).toBe("Lane");
  });

  it("lists bans and unbans by name substring", async () => {
    const { deps, bl } = makeDeps({
      song: { id: "abc123xyz01", name: "Yacht Rock Jam", artist: "Smooth" },
    });
    const ex = new CommandExecutor(deps);
    await ex.execute({ name: "ban", args: "", rawArgs: [], flags: new Set() }, undefined);
    const list = await ex.execute({
      name: "ban",
      args: "list",
      rawArgs: ["list"],
      flags: new Set(),
    });
    expect(list).toContain("Yacht Rock Jam");

    // Nothing playing after skip — unban by name
    deps.queue.clear();
    const un = await ex.execute({
      name: "unban",
      args: "yacht",
      rawArgs: ["yacht"],
      flags: new Set(),
    });
    expect(un).toMatch(/Unbanned/);
    expect(bl.list()).toHaveLength(0);
  });

  it("refuses when nothing is playing", async () => {
    const { deps } = makeDeps({ song: null });
    const ex = new CommandExecutor(deps);
    const out = await ex.execute({ name: "ban", args: "", rawArgs: [], flags: new Set() });
    expect(out).toMatch(/Nothing is playing/);
  });
});
