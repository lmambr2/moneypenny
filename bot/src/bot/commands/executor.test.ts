import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlayQueue, type QueuedSong } from "../../audio/queue.js";
import { AUDIO_COMMANDS, type ParsedCommand } from "../commands.js";
import { CommandExecutor, type CommandExecutorDeps } from "./executor.js";

function cmd(name: string, args = ""): ParsedCommand {
  const trimmed = args.trim();
  return {
    name,
    args,
    rawArgs: trimmed ? trimmed.split(/\s+/) : [],
    flags: new Set<string>(),
  };
}

function song(over: Partial<QueuedSong> = {}): QueuedSong {
  return {
    id: over.id ?? "id-1",
    name: over.name ?? "Track One",
    artist: over.artist ?? "Artist",
    album: over.album ?? "Album",
    platform: over.platform ?? "local",
    coverUrl: over.coverUrl ?? "",
    duration: over.duration ?? 180,
    source: over.source,
  };
}

/**
 * Minimal deps. Everything the executor calls is a spy so tests assert the
 * delegation contract rather than re-testing PlaybackEngine.
 */
function makeDeps(over: Partial<CommandExecutorDeps> = {}) {
  const queue = new PlayQueue();
  const playback = {
    pausePlayback: vi.fn(() => "Paused"),
    resumePlayback: vi.fn(async () => "Resumed"),
    clearUserPause: vi.fn(),
    playNext: vi.fn(async () => true),
    isUserPaused: vi.fn(() => false),
  };
  const player = {
    stop: vi.fn(),
    setVolume: vi.fn(),
    getVolume: vi.fn(() => 30),
    getState: vi.fn(() => "playing" as const),
    resetFailures: vi.fn(),
  };
  const profileManager = { onSongChange: vi.fn(async () => {}) };

  const deps = {
    playback,
    player,
    queue,
    config: { commandPrefix: "!" },
    profileManager,
    tsClient: {},
    isConnected: vi.fn(() => true),
    playNext: vi.fn(async () => true),
    getProvider: vi.fn(),
    ...over,
  } as unknown as CommandExecutorDeps;

  return {
    deps,
    queue,
    playback,
    player,
    profileManager,
    exec: new CommandExecutor(deps),
  };
}

describe("CommandExecutor connection guard", () => {
  // Audio commands must fail loudly when TS is down rather than mutating the
  // queue against a bot that cannot play anything.
  it("throws for audio commands while disconnected", async () => {
    const { exec } = makeDeps({ isConnected: () => false });
    const audioName = [...AUDIO_COMMANDS][0]!;
    await expect(exec.execute(cmd(audioName))).rejects.toThrow(/not connected/i);
  });

  it("allows non-audio commands while disconnected", async () => {
    const { exec } = makeDeps({ isConnected: () => false });
    expect(AUDIO_COMMANDS.has("help")).toBe(false);
    await expect(exec.execute(cmd("help"))).resolves.toBeTruthy();
  });

  it("allows audio commands once connected", async () => {
    const { exec } = makeDeps();
    await expect(exec.execute(cmd("pause"))).resolves.toBe("Paused");
  });
});

describe("CommandExecutor transport delegation", () => {
  let h: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    h = makeDeps();
  });

  it("pause goes through the PlaybackEngine checkpoint, not player.pause", async () => {
    await h.exec.execute(cmd("pause"));
    expect(h.playback.pausePlayback).toHaveBeenCalledOnce();
  });

  it("resume goes through the PlaybackEngine", async () => {
    await expect(h.exec.execute(cmd("resume"))).resolves.toBe("Resumed");
    expect(h.playback.resumePlayback).toHaveBeenCalledOnce();
  });

  it("stop clears the operator pause, stops the player and empties the queue", async () => {
    h.queue.add(song());
    h.queue.play();
    const out = await h.exec.execute(cmd("stop"));
    expect(out).toMatch(/stopped/i);
    expect(h.playback.clearUserPause).toHaveBeenCalled();
    expect(h.player.stop).toHaveBeenCalled();
    expect(h.queue.isEmpty()).toBe(true);
    expect(h.profileManager.onSongChange).toHaveBeenCalledWith(null);
  });

  // skip/next only advance — never start a title (that's jump/go/playnext).
  it("skip with no args advances via playNext and clears the operator pause", async () => {
    const out = await h.exec.execute(cmd("skip"));
    expect(h.playback.clearUserPause).toHaveBeenCalled();
    expect(h.deps.playNext).toHaveBeenCalledOnce();
    expect(out).toMatch(/queue is empty/i);
  });

  it("skip reports the track it landed on", async () => {
    h.queue.add(song({ name: "Landed", artist: "Band" }));
    h.queue.play();
    const out = await h.exec.execute(cmd("skip"));
    expect(out).toContain("Landed");
    expect(out).toContain("Band");
  });
});

// A manual skip is a track boundary, so the director gets first refusal —
// it may insert a due station break instead of advancing the music.
describe("CommandExecutor skip vs radio boundary", () => {
  function withRadio(boundary: "bumper" | "advanced") {
    const radio = {
      cueBumper: vi.fn(),
      cueSay: vi.fn(),
      skipBumper: vi.fn(),
      onTrackBoundary: vi.fn(async () => boundary),
      status: vi.fn(() => ({
        songsUntilBumper: null,
        cuePending: false,
        skipNextPending: false,
      })),
    };
    return { radio, ...makeDeps({ radio } as Partial<CommandExecutorDeps>) };
  }

  it("lets the director take the boundary and does not advance the queue", async () => {
    const h = withRadio("bumper");
    const out = await h.exec.execute(cmd("skip"));
    expect(h.radio.onTrackBoundary).toHaveBeenCalledOnce();
    expect(out).toMatch(/station break/i);
    expect(h.deps.playNext).not.toHaveBeenCalled();
  });

  it("reports the new track when the director just advanced", async () => {
    const h = withRadio("advanced");
    h.queue.add(song({ name: "After Break" }));
    h.queue.play();
    const out = await h.exec.execute(cmd("skip"));
    expect(out).not.toMatch(/station break/i);
    expect(out).toContain("After Break");
  });

  // With a director present the executor must not ALSO call playNext, or a
  // skip advances two tracks.
  it("never double-advances when a director is wired", async () => {
    const h = withRadio("advanced");
    await h.exec.execute(cmd("skip"));
    expect(h.deps.playNext).not.toHaveBeenCalled();
  });
});

describe("CommandExecutor skip argument handling", () => {
  /**
   * Args on skip/next are ignored (advance only). We used to refuse with:
   *   "!skip / !next only advance the queue. To start a title… !jump …"
   * That reply LED with the command prefix, TeamSpeak echoed it as the bot's
   * own message, re-parse → same reply → channel flood until restart.
   */
  it("skip with a query still only advances (never searches, never usage-spam)", async () => {
    const searchFirst = vi.fn(async () => ({
      provider: { platform: "youtube" as const },
      song: song({ id: "yt-1", name: "Some Song", artist: "Somebody" }),
    }));
    const h = makeDeps();
    (h.deps.playback as unknown as { searchFirst: unknown }).searchFirst = searchFirst;
    const out = await h.exec.execute(cmd("skip", "ella langley"));
    expect(searchFirst).not.toHaveBeenCalled();
    expect(h.deps.playNext).toHaveBeenCalledOnce();
    expect(out?.trimStart().startsWith("!")).toBe(false);
    expect(out).not.toMatch(/only advance the queue/i);
    expect(out).not.toMatch(/!jump/i);
  });

  it("next is an alias of skip (args ignored)", async () => {
    const h = makeDeps();
    const out = await h.exec.execute(cmd("next", "some song"));
    expect(h.deps.playNext).toHaveBeenCalledOnce();
    expect(out?.trimStart().startsWith("!")).toBe(false);
    expect(out).not.toMatch(/only advance the queue/i);
  });

  it("never returns a reply that itself starts with the command prefix", async () => {
    const h = makeDeps();
    for (const c of [cmd("skip", "some song"), cmd("next", "some song"), cmd("skip")]) {
      const out = await h.exec.execute(c);
      expect(out?.trimStart().startsWith("!")).toBe(false);
    }
  });
});

describe("CommandExecutor !vol validation", () => {
  it.each([
    ["0", 0],
    ["50", 50],
    ["100", 100],
  ])("accepts in-range %s", async (arg, expected) => {
    const h = makeDeps();
    const out = await h.exec.execute(cmd("vol", arg));
    expect(h.player.setVolume).toHaveBeenCalledWith(expected);
    expect(out).toContain(`${expected}%`);
  });

  it.each(["-1", "101", "abc", "", "  ", "NaN"])("rejects out-of-range %o", async (arg) => {
    const h = makeDeps();
    const out = await h.exec.execute(cmd("vol", arg));
    expect(out).toMatch(/usage/i);
    expect(h.player.setVolume).not.toHaveBeenCalled();
  });

  // parseInt("50abc") is 50 — documenting that trailing junk is tolerated
  // rather than silently changing behavior.
  it("tolerates a trailing suffix the way parseInt does", async () => {
    const h = makeDeps();
    await h.exec.execute(cmd("vol", "50abc"));
    expect(h.player.setVolume).toHaveBeenCalledWith(50);
  });
});

describe("CommandExecutor queue reporting", () => {
  it("reports an empty queue", async () => {
    const h = makeDeps();
    await expect(h.exec.execute(cmd("queue"))).resolves.toMatch(/empty/i);
    await expect(h.exec.execute(cmd("now"))).resolves.toMatch(/nothing is playing/i);
  });

  it("marks the current track in the listing", async () => {
    const h = makeDeps();
    h.queue.add(song({ id: "a", name: "First" }));
    h.queue.add(song({ id: "b", name: "Second" }));
    h.queue.play();
    const out = (await h.exec.execute(cmd("queue"))) ?? "";
    expect(out).toContain("First");
    expect(out).toContain("Second");
    expect(out).toContain("▶");
  });

  it("now reports the current track with platform", async () => {
    const h = makeDeps();
    h.queue.add(song({ name: "Playing Now", artist: "Someone" }));
    h.queue.play();
    const out = (await h.exec.execute(cmd("now"))) ?? "";
    expect(out).toContain("Playing Now");
    expect(out).toContain("Someone");
    expect(out).toContain("local");
  });

  it("list is an alias of queue", async () => {
    const h = makeDeps();
    await expect(h.exec.execute(cmd("list"))).resolves.toMatch(/empty/i);
  });
});
