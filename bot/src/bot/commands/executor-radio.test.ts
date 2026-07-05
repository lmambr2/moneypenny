import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { CommandExecutor } from "./executor.js";
import { defaultRadioConfig, TagStore, type RadioConfig } from "../../radio/index.js";

function executor(radio: RadioConfig = defaultRadioConfig()) {
  const config = { commandPrefix: "!", radio } as never;
  const ex = new CommandExecutor({
    playback: {} as never,
    player: {} as never,
    queue: {} as never,
    config,
    profileManager: {} as never,
    tsClient: {} as never,
    isConnected: () => true,
    playNext: vi.fn(),
    getProvider: vi.fn(),
  });
  return { ex, radio };
}

const run = (ex: CommandExecutor, args: string[]) =>
  ex.execute({ name: "radio", args: args.join(" "), rawArgs: args, flags: new Set() });

describe("cmdRadio", () => {
  it("on enables radio and reports the cadence", async () => {
    const { ex, radio } = executor();
    const out = await run(ex, ["on"]);
    expect(radio.enabled).toBe(true);
    expect(out).toMatch(/ON/);
    expect(out).toContain("every 4 songs");
  });

  it("off disables radio", async () => {
    const r = defaultRadioConfig();
    r.enabled = true;
    const { ex, radio } = executor(r);
    const out = await run(ex, ["off"]);
    expect(radio.enabled).toBe(false);
    expect(out).toMatch(/OFF/);
  });

  it("bare !radio reports status (off, with a hint)", async () => {
    const out = await run(executor().ex, []);
    expect(out).toMatch(/OFF/);
    expect(out).toContain("!radio on");
  });

  it("reports clock-only when everyNSongs is 0", async () => {
    const r = defaultRadioConfig();
    r.everyNSongs = 0;
    const out = await run(executor(r).ex, ["on"]);
    expect(out).toContain("Clock-only");
  });

  it("shows usage for an unknown subcommand", async () => {
    const out = await run(executor().ex, ["frobnicate"]);
    expect(out).toContain("Usage:");
  });
});

describe("cmdRadio ops (§8/§12)", () => {
  function opsHarness() {
    const radio = defaultRadioConfig();
    radio.profiles = {
      mining: {
        name: "mining",
        music: {
          select: { genreAny: ["ambient"] },
          playlistRefs: [
            { platform: "local", ref: "ops-mining" },
            { platform: "spotify", ref: "https://open.spotify.com/playlist/x" }, // skipped (§8.1)
          ],
          seedQueries: ["ambient focus"],
        },
        bumper: { topics: ["refinery yields"] },
      },
      empty: { name: "empty", music: { seedQueries: [] } },
    };

    const tagStore = new TagStore({ db: new Database(":memory:") });
    tagStore.upsert("t1", { genre: "ambient" }, "analyzer");

    const queued: { id: string }[] = [];
    const queue = {
      clear: vi.fn(() => queued.splice(0)),
      add: vi.fn((s: { id: string }) => queued.push(s)),
      play: vi.fn(() => queued[0] ?? null),
      current: vi.fn(() => queued[0] ?? null),
    };
    const localProvider = {
      platform: "local",
      getSongDetail: vi.fn(async (id: string) => ({ id, name: id, artist: "", album: "", duration: 1, coverUrl: "", platform: "local" })),
      search: vi.fn(async () => ({ songs: [], playlists: [{ id: "pl1", name: "ops-mining" }], albums: [] })),
      getPlaylistSongs: vi.fn(async () => [
        { id: "m3u-1", name: "m3u-1", artist: "", album: "", duration: 1, coverUrl: "", platform: "local" },
      ]),
    };
    const ex = new CommandExecutor({
      playback: {
        resolveAndPlay: vi.fn(async () => true),
        extractId: (s: string) => s,
        searchFirst: vi.fn(async () => ({
          provider: { platform: "local" },
          song: { id: "seed-1", name: "seed", artist: "", album: "", duration: 1, coverUrl: "", platform: "local" },
        })),
      } as never,
      player: { getState: () => "idle", resetFailures: vi.fn() } as never,
      queue: queue as never,
      config: { commandPrefix: "!", radio } as never,
      profileManager: {} as never,
      tsClient: {} as never,
      isConnected: () => true,
      playNext: vi.fn(),
      getProvider: vi.fn(() => localProvider as never),
      tagStore,
    });
    return { ex, radio, queue, queued };
  }

  it("ops list names profiles and the active one", async () => {
    const { ex } = opsHarness();
    const out = await run(ex, ["ops", "list"]);
    expect(out).toContain("mining");
    expect(out).toContain("active: idle");
  });

  it("ops <profile> sets the op context and programs music from tags + playlists", async () => {
    const { ex, radio, queued } = opsHarness();
    const out = await run(ex, ["ops", "mining"]);
    expect(radio.activeProfile).toBe("mining"); // doctrine bumper topics now read this
    expect(out).toContain("Op context: mining");
    const ids = queued.map((s) => s.id);
    expect(ids).toContain("t1"); // tag select
    expect(ids).toContain("m3u-1"); // local playlist ref (spotify ref skipped)
  });

  it("a profile with no matching sources retunes bumpers without touching music", async () => {
    const { ex, radio, queue } = opsHarness();
    const out = await run(ex, ["ops", "empty"]);
    expect(radio.activeProfile).toBe("empty");
    expect(out).toContain("no music sources matched");
    expect(queue.clear).not.toHaveBeenCalled(); // never opens a gap
  });

  it("unknown profile lists what exists", async () => {
    const { ex } = opsHarness();
    expect(await run(ex, ["ops", "nope"])).toContain("Unknown profile 'nope'");
  });
});

describe("!skip routes through the radio director (skip = boundary)", () => {
  function skipHarness(result: "bumper" | "advanced") {
    const radio = {
      cueBumper: vi.fn(), cueSay: vi.fn(), skipBumper: vi.fn(),
      onTrackBoundary: vi.fn(async () => result),
      status: vi.fn(() => ({ songsUntilBumper: null, cuePending: false, skipNextPending: false })),
    };
    const playNext = vi.fn();
    const ex = new CommandExecutor({
      playback: {} as never,
      player: {} as never,
      queue: { current: () => ({ name: "Next Song", artist: "A" }) } as never,
      config: { commandPrefix: "!", radio: defaultRadioConfig() } as never,
      profileManager: {} as never,
      tsClient: {} as never,
      isConnected: () => true,
      playNext,
      getProvider: vi.fn(),
      radio: radio as never,
    });
    return { ex, radio, playNext };
  }

  it("a due bumper plays on skip and the reply says so", async () => {
    const { ex, radio, playNext } = skipHarness("bumper");
    const out = await ex.execute({ name: "skip", args: "", rawArgs: [], flags: new Set() });
    expect(radio.onTrackBoundary).toHaveBeenCalledTimes(1);
    expect(playNext).not.toHaveBeenCalled(); // director owns the advance
    expect(out).toContain("Station break");
  });

  it("a song slot advances normally with the usual reply", async () => {
    const { ex } = skipHarness("advanced");
    const out = await ex.execute({ name: "skip", args: "", rawArgs: [], flags: new Set() });
    expect(out).toContain("Now playing: Next Song");
  });
});
