import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { defaultRadioConfig, type RadioConfig, TagStore } from "../../radio/index.js";
import { CommandExecutor } from "./executor.js";

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
            { platform: "spotify", ref: "https://open.spotify.com/playlist/x" }, // R-R6 via stream bridge
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
    let currentIndex = -1;
    const queue = {
      clear: vi.fn(() => {
        queued.splice(0);
        currentIndex = -1;
      }),
      add: vi.fn((s: { id: string }) => {
        queued.push(s);
        return queued.length - 1;
      }),
      play: vi.fn(() => {
        currentIndex = queued.length ? 0 : -1;
        return queued[0] ?? null;
      }),
      playAt: vi.fn((i: number) => {
        currentIndex = i;
        return queued[i] ?? null;
      }),
      next: vi.fn(() => {
        if (currentIndex + 1 >= queued.length) return null;
        currentIndex++;
        return queued[currentIndex] ?? null;
      }),
      current: vi.fn(() => (currentIndex >= 0 ? (queued[currentIndex] ?? null) : null)),
      list: vi.fn(() => [...queued]),
      getCurrentIndex: vi.fn(() => currentIndex),
      size: vi.fn(() => queued.length),
    };
    const localProvider = {
      platform: "local",
      getSongDetail: vi.fn(async (id: string) => ({
        id,
        name: id,
        artist: "",
        album: "",
        duration: 1,
        coverUrl: "",
        platform: "local",
      })),
      search: vi.fn(async () => ({
        songs: [],
        playlists: [{ id: "pl1", name: "ops-mining" }],
        albums: [],
      })),
      getPlaylistSongs: vi.fn(async () => [
        {
          id: "m3u-1",
          name: "m3u-1",
          artist: "",
          album: "",
          duration: 1,
          coverUrl: "",
          platform: "local",
        },
      ]),
    };
    const streamProvider = {
      platform: "stream",
      getPlaylistSongs: vi.fn(async () => [
        {
          id: "spotify:track:sp1",
          name: "Spot Track",
          artist: "S",
          album: "Spotify",
          duration: 1,
          coverUrl: "",
          platform: "stream",
        },
      ]),
    };
    const ex = new CommandExecutor({
      playback: {
        resolveAndPlay: vi.fn(async () => true),
        extractId: (s: string) => s,
        searchFirst: vi.fn(async () => ({
          provider: { platform: "local" },
          song: {
            id: "seed-1",
            name: "seed",
            artist: "",
            album: "",
            duration: 1,
            coverUrl: "",
            platform: "local",
          },
        })),
      } as never,
      player: { getState: () => "idle", resetFailures: vi.fn() } as never,
      queue: queue as never,
      config: { commandPrefix: "!", radio } as never,
      profileManager: {} as never,
      tsClient: {} as never,
      isConnected: () => true,
      playNext: vi.fn(),
      getProvider: vi.fn((flags: Set<string>) =>
        flags.has("s") ? (streamProvider as never) : (localProvider as never),
      ),
      tagStore,
    });
    return { ex, radio, queue, queued, streamProvider };
  }

  it("ops list names profiles and the active one", async () => {
    const { ex } = opsHarness();
    const out = await run(ex, ["ops", "list"]);
    expect(out).toContain("mining");
    expect(out).toContain("active: lobby");
  });

  it("ops <profile> sets the op context and programs music from tags + playlists", async () => {
    const { ex, radio, queued } = opsHarness();
    const out = await run(ex, ["ops", "mining"]);
    expect(radio.activeProfile).toBe("mining"); // doctrine bumper topics now read this
    expect(out).toContain("Op context: mining");
    const ids = queued.map((s) => s.id);
    expect(ids).toContain("t1"); // tag select
    expect(ids).toContain("m3u-1"); // local playlist ref
    expect(ids).toContain("spotify:track:sp1"); // R-R6 spotify playlist via stream bridge
  });

  it("starts relay timer on relay-only profile and stops when switching away", async () => {
    const radio = defaultRadioConfig();
    radio.profiles = {
      relay: {
        name: "relay",
        music: {
          relayUrl: "https://icecast.example.org:8000/live.mp3",
          relayBumperIntervalSec: 60,
        },
      },
      library: {
        name: "library",
        music: {
          playlistRefs: [{ platform: "local", ref: "ops-mining" }],
        },
      },
    };
    const onRelayChanged = vi.fn();
    const localProvider = {
      platform: "local",
      getSongDetail: vi.fn(async (id: string) => ({
        id,
        name: id,
        artist: "",
        album: "",
        duration: 1,
        coverUrl: "",
        platform: "local",
      })),
      search: vi.fn(async () => ({
        songs: [],
        playlists: [{ id: "pl1", name: "ops-mining" }],
        albums: [],
      })),
      getPlaylistSongs: vi.fn(async () => [
        {
          id: "lib-1",
          name: "lib-1",
          artist: "",
          album: "",
          duration: 1,
          coverUrl: "",
          platform: "local",
        },
      ]),
    };
    const queue = {
      clear: vi.fn(),
      add: vi.fn(),
      play: vi.fn(() => ({ id: "x", platform: "stream" })),
      playAt: vi.fn(),
      next: vi.fn(() => null),
      current: vi.fn(() => null),
      list: vi.fn(() => []),
      getCurrentIndex: vi.fn(() => -1),
      size: vi.fn(() => 0),
    };
    const ex = new CommandExecutor({
      playback: {
        resolveAndPlay: vi.fn(async () => true),
        extractId: (s: string) => s,
        searchFirst: vi.fn(async () => null),
      } as never,
      player: { getState: () => "idle", resetFailures: vi.fn() } as never,
      queue: queue as never,
      config: { commandPrefix: "!", radio } as never,
      profileManager: {} as never,
      tsClient: {} as never,
      isConnected: () => true,
      playNext: vi.fn(),
      getProvider: vi.fn(() => localProvider as never),
      tagStore: new TagStore({ db: new Database(":memory:") }),
      onRelayChanged,
    });

    await run(ex, ["ops", "relay"]);
    expect(onRelayChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        relayUrl: "https://icecast.example.org:8000/live.mp3",
        bumperIntervalSec: 60,
      }),
    );

    onRelayChanged.mockClear();
    await run(ex, ["ops", "library"]);
    expect(onRelayChanged).toHaveBeenCalledWith(null);

    onRelayChanged.mockClear();
    await run(ex, ["off"]);
    expect(onRelayChanged).toHaveBeenCalledWith(null);
  });

  it("a profile with no matching sources retunes bumpers without touching music", async () => {
    const { ex, radio, queue } = opsHarness();
    const out = await run(ex, ["ops", "empty"]);
    expect(radio.activeProfile).toBe("empty");
    expect(out).toContain("no music sources matched");
    expect(queue.clear).not.toHaveBeenCalled(); // never opens a gap
  });

  it("autoProgramRadio restocks from the active profile (dead-air self-heal)", async () => {
    const { ex, radio, queued } = opsHarness();
    radio.activeProfile = "mining";
    expect(await ex.autoProgramRadio()).toBe(true);
    expect(queued.length).toBeGreaterThan(0);
    radio.activeProfile = "nope"; // no such profile → false, queue untouched
    const before = queued.length;
    expect(await ex.autoProgramRadio()).toBe(false);
    expect(queued.length).toBe(before);
  });

  it("unknown profile lists what exists", async () => {
    const { ex } = opsHarness();
    expect(await run(ex, ["ops", "nope"])).toContain("Unknown profile 'nope'");
  });
});

describe("!skip routes through the radio director (skip = boundary)", () => {
  function skipHarness(result: "bumper" | "advanced") {
    const radio = {
      cueBumper: vi.fn(),
      cueSay: vi.fn(),
      skipBumper: vi.fn(),
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
