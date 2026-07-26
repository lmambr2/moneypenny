import { describe, expect, it, vi } from "vitest";
import type { Song } from "../../music/provider.js";
import type { CommandExecutorDeps } from "./executor.js";
import {
  artistDiversityKey,
  diversifyArtists,
  isRadioSeedFriendlySong,
  mixLocalAndExternalSeeds,
  orderSeedCandidates,
  RadioCommands,
  shuffleSongs,
} from "./radio-commands.js";

function song(partial: Partial<Song> & { id: string; name: string }): Song {
  return {
    artist: partial.artist ?? "",
    album: partial.album ?? "",
    duration: partial.duration ?? 180,
    coverUrl: "",
    platform: "local",
    ...partial,
  };
}

/** Minimal queue surface for autoProgram restock (preserves user tracks). */
function mockQueue(opts?: {
  list?: unknown[];
  current?: unknown;
  currentIndex?: number;
  onAdd?: (s: Song) => void;
}) {
  const added: Song[] = [];
  return {
    clear: vi.fn(),
    add: vi.fn((s: Song) => {
      added.push(s);
      opts?.onAdd?.(s);
    }),
    play: vi.fn(() => added[0] ?? null),
    playAt: vi.fn(),
    list: vi.fn(() => opts?.list ?? []),
    current: vi.fn(() => opts?.current ?? null),
    getCurrentIndex: vi.fn(() => opts?.currentIndex ?? -1),
    setMode: vi.fn(),
    size: () => added.length,
    _added: added,
  };
}

describe("isRadioSeedFriendlySong", () => {
  it("accepts normal-length tracks", () => {
    expect(isRadioSeedFriendlySong(song({ id: "a", name: "Night Drive", duration: 240 }))).toBe(
      true,
    );
  });

  it("rejects rap / hip-hop / R&B under default genre policy", () => {
    expect(isRadioSeedFriendlySong(song({ id: "r", name: "Hip-Hop Anthem", duration: 180 }))).toBe(
      false,
    );
    expect(isRadioSeedFriendlySong(song({ id: "y", name: "Yacht Rock", duration: 180 }))).toBe(
      true,
    );
  });

  it("rejects multi-hour titles and over-long durations", () => {
    expect(
      isRadioSeedFriendlySong(
        song({
          id: "q",
          name: "4 Hours of Ambient Study Music To Concentrate",
          duration: 0,
        }),
      ),
    ).toBe(false);
    expect(
      isRadioSeedFriendlySong(
        song({
          id: "b",
          name: "B A D L A N D S - A Synthwave Mix for Galactic Explorers Vol. 1",
          duration: 0,
        }),
      ),
    ).toBe(false);
    expect(
      isRadioSeedFriendlySong(song({ id: "long", name: "Epic Track", duration: 2 * 3600 })),
    ).toBe(false);
    expect(
      isRadioSeedFriendlySong(song({ id: "alb", name: "Led Zeppelin II Full Album", duration: 0 })),
    ).toBe(false);
  });

  it("rejects documentaries / non-music YouTube junk", () => {
    expect(
      isRadioSeedFriendlySong(
        song({
          id: "doc",
          name: "The Real History of the Illuminati — Full Documentary",
          artist: "History Channel",
          platform: "youtube",
          duration: 720,
        }),
      ),
    ).toBe(false);
    expect(
      isRadioSeedFriendlySong(
        song({
          id: "pod",
          name: "True Crime Podcast Episode 12",
          platform: "youtube",
          duration: 400,
        }),
      ),
    ).toBe(false);
  });

  it("rejects YouTube 24/7 LIVE radio streams (No URL dead air)", () => {
    expect(
      isRadioSeedFriendlySong(
        song({
          id: "live1",
          name: "Classic Rock Radio 🔴️ 24/7 Nonstop Classic Hits | Van Halen 2026-07-12 00:33",
          platform: "youtube",
          duration: 0,
        }),
      ),
    ).toBe(false);
    expect(
      isRadioSeedFriendlySong(
        song({
          id: "live2",
          name: "Rock Classics ⚡ [ LIVE ] Timeless Rock Hits of the 70s",
          platform: "youtube",
          duration: 0,
        }),
      ),
    ).toBe(false);
    expect(
      isRadioSeedFriendlySong(
        song({
          id: "lofi",
          name: "synthwave radio 🌌 beats to chill/game to 2026-07-12 00:33",
          artist: "Lofi Girl",
          platform: "youtube",
          duration: 0,
        }),
      ),
    ).toBe(false);
  });
});

describe("orderSeedCandidates / shuffleSongs", () => {
  it("prefers ids not in recent memory", () => {
    const cands = [{ id: "old" }, { id: "new-a" }, { id: "new-b" }];
    const out = orderSeedCandidates(cands, ["old"], { shuffle: false });
    expect(out[0]?.id).not.toBe("old");
    expect(out.map((x) => x.id)).toContain("old"); // still included after fresh
  });

  it("shuffles with a fixed rng", () => {
    const items = [1, 2, 3, 4];
    let i = 0;
    const rng = () => {
      const seq = [0.9, 0.1, 0.5, 0.2];
      return seq[i++ % seq.length]!;
    };
    const a = shuffleSongs(items, rng);
    expect(a).toHaveLength(4);
    expect(new Set(a).size).toBe(4);
  });
});

describe("mixLocalAndExternalSeeds (33/66 default)", () => {
  it("targets about one-third local when both sides are full", () => {
    type Hit = { id: string; platform: "local" | "youtube" };
    const local: Hit[] = Array.from({ length: 20 }, (_, i) => ({
      id: `L${i}`,
      platform: "local",
    }));
    const external: Hit[] = Array.from({ length: 20 }, (_, i) => ({
      id: `Y${i}`,
      platform: "youtube",
    }));
    const out = mixLocalAndExternalSeeds(local, external, {
      cap: 18,
      externalRatio: 2 / 3,
      shuffle: false,
    });
    expect(out).toHaveLength(18);
    const localN = out.filter((s) => s.platform === "local").length;
    const extN = out.filter((s) => s.platform === "youtube").length;
    // ~6 local / ~12 external (allow ±1 from rounding)
    expect(localN).toBeGreaterThanOrEqual(5);
    expect(localN).toBeLessThanOrEqual(7);
    expect(extN).toBeGreaterThanOrEqual(11);
    expect(extN).toBeLessThanOrEqual(13);
  });

  it("fills from external when local is thin", () => {
    type Hit = { id: string; platform: "local" | "youtube" };
    const local: Hit[] = [{ id: "L0", platform: "local" }];
    const external: Hit[] = Array.from({ length: 10 }, (_, i) => ({
      id: `Y${i}`,
      platform: "youtube",
    }));
    const out = mixLocalAndExternalSeeds(local, external, {
      cap: 8,
      externalRatio: 2 / 3,
      shuffle: false,
    });
    expect(out).toHaveLength(8);
    expect(out.filter((s) => s.platform === "local")).toHaveLength(1);
  });
});

describe("RadioCommands seed pool (local multi-hit)", () => {
  it("builds a multi-track local pool and skips mega-mixes", async () => {
    const library: Song[] = [
      song({
        id: "mix",
        name: "B A D L A N D S - A Synthwave Mix for Galactic Explorers Vol. 1",
        duration: 0,
      }),
      song({ id: "s1", name: "Synthwave Night", duration: 200 }),
      song({ id: "s2", name: "City Synthwave Lights", duration: 210 }),
      song({ id: "s3", name: "Neon Synthwave Run", duration: 190 }),
    ];
    const ytHits: Song[] = [
      song({
        id: "yt1",
        name: "Synthwave Drive",
        duration: 220,
        platform: "youtube",
      }),
      song({
        id: "ytmix",
        name: "10 Hours of Synthwave Mix",
        duration: 0,
        platform: "youtube",
      }),
    ];
    const localSearch = vi.fn(async (q: string, _limit?: number) => {
      const ql = q.toLowerCase();
      const songs = !ql
        ? library
        : library.filter(
            (s) => s.name.toLowerCase().includes(ql) || s.artist.toLowerCase().includes(ql),
          );
      return { songs, playlists: [], albums: [] };
    });
    const ytSearch = vi.fn(async () => ({
      songs: ytHits,
      playlists: [],
      albums: [],
    }));
    const queue = mockQueue();
    const deps = {
      config: {
        commandPrefix: "!",
        aceStepAutoFill: false,
        radio: {
          enabled: true,
          activeProfile: "lobby",
          profiles: {
            lobby: {
              name: "lobby",
              music: { seedQueries: ["synthwave"], shuffle: true },
            },
          },
        },
      },
      queue,
      player: { resetFailures: vi.fn(), getState: () => "idle" },
      playback: { resolveAndPlay: vi.fn(async () => true), searchFirst: vi.fn() },
      getProvider: vi.fn((flags: Set<string>) => {
        if (flags.has("y")) return { platform: "youtube", search: ytSearch };
        return { platform: "local", search: localSearch };
      }),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as CommandExecutorDeps;

    const cmds = new RadioCommands(deps, async () => []);
    const ok = await cmds.autoProgram();
    expect(ok).toBe(true);
    const added = queue._added;
    expect(added.map((a) => a.id)).not.toContain("mix");
    expect(added.map((a) => a.id)).not.toContain("ytmix");
    expect(added.length).toBeGreaterThanOrEqual(2);
    expect(localSearch).toHaveBeenCalled();
    expect(ytSearch).toHaveBeenCalled();
    expect(added.some((a) => a.platform === "youtube")).toBe(true);
    expect(added.some((a) => a.platform === "local")).toBe(true);
    // Must not have used generic searchFirst helper
    expect(deps.playback.searchFirst).not.toHaveBeenCalled();
  });

  it("seedSources local-only skips YouTube", async () => {
    const library = [song({ id: "s1", name: "Synthwave Night", duration: 200 })];
    const localSearch = vi.fn(async () => ({
      songs: library,
      playlists: [],
      albums: [],
    }));
    const ytSearch = vi.fn(async () => ({
      songs: [song({ id: "yt1", name: "Remote", duration: 180, platform: "youtube" })],
      playlists: [],
      albums: [],
    }));
    const queue = mockQueue();
    const deps = {
      config: {
        commandPrefix: "!",
        aceStepAutoFill: false,
        radio: {
          enabled: true,
          activeProfile: "lobby",
          profiles: {
            lobby: {
              name: "lobby",
              music: {
                seedQueries: ["synthwave"],
                seedSources: ["local"],
                shuffle: false,
              },
            },
          },
        },
      },
      queue,
      player: { resetFailures: vi.fn(), getState: () => "idle" },
      playback: { resolveAndPlay: vi.fn(async () => true), searchFirst: vi.fn() },
      getProvider: vi.fn((flags: Set<string>) => {
        if (flags.has("y")) return { platform: "youtube", search: ytSearch };
        return { platform: "local", search: localSearch };
      }),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as CommandExecutorDeps;

    const cmds = new RadioCommands(deps, async () => []);
    expect(await cmds.autoProgram()).toBe(true);
    expect(ytSearch).not.toHaveBeenCalled();
    expect(queue._added.map((s) => s.id)).toEqual(["s1"]);
  });

  it("restock preserves user !add tracks while playing", async () => {
    const userTrack = {
      ...song({ id: "user1", name: "User Add" }),
      source: "user" as const,
      platform: "youtube" as const,
    };
    const nowPlaying = {
      ...song({ id: "now", name: "Now Playing" }),
      source: "radio" as const,
      platform: "local" as const,
    };
    const localSearch = vi.fn(async () => ({
      songs: [song({ id: "seed1", name: "Seed A", duration: 180 })],
      playlists: [],
      albums: [],
    }));
    const queue = mockQueue({
      list: [nowPlaying, userTrack],
      current: nowPlaying,
      currentIndex: 0,
    });
    const resolveAndPlay = vi.fn(async () => true);
    const deps = {
      config: {
        commandPrefix: "!",
        aceStepAutoFill: false,
        radio: {
          enabled: true,
          activeProfile: "lobby",
          profiles: {
            lobby: {
              name: "lobby",
              music: { seedQueries: ["rock"], seedSources: ["local"], shuffle: false },
            },
          },
        },
      },
      queue,
      player: { resetFailures: vi.fn(), getState: () => "playing" },
      playback: { resolveAndPlay, searchFirst: vi.fn() },
      getProvider: vi.fn(() => ({ platform: "local", search: localSearch })),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as CommandExecutorDeps;

    const cmds = new RadioCommands(deps, async () => []);
    expect(await cmds.autoProgram()).toBe(true);
    expect(resolveAndPlay).not.toHaveBeenCalled(); // keep stream
    expect(queue.playAt).toHaveBeenCalledWith(0);
    const ids = queue._added.map((s) => s.id);
    expect(ids[0]).toBe("now");
    expect(ids).toContain("user1");
    expect(ids).toContain("seed1");
  });

  it("profile aceStepAutoFill true runs gen even when global autoFill is off", async () => {
    const genSong = song({ id: "g1", name: "Gen", duration: 90 });
    const generateAndIngest = vi.fn(async () => ({
      ok: true as const,
      song: genSong,
      relPath: "generated/ace-step/x.mp3",
      jobId: "j1",
    }));
    const deps = {
      config: {
        commandPrefix: "!",
        aceStepAutoFill: false,
        aceStepEnabled: true,
        aceStepUrl: "http://x",
        radio: {
          enabled: true,
          activeProfile: "focus",
          profiles: {
            focus: {
              name: "focus",
              music: { seedQueries: [], aceStepAutoFill: true },
            },
          },
        },
      },
      queue: mockQueue(),
      player: { resetFailures: vi.fn(), getState: () => "idle" },
      playback: {
        resolveAndPlay: vi.fn(async () => true),
        searchFirst: vi.fn(async () => null),
      },
      getProvider: vi.fn(() => ({
        platform: "local",
        search: vi.fn(async () => ({ songs: [], playlists: [], albums: [] })),
      })),
      generateProvider: {
        isConfigured: () => true,
        isBusy: () => false,
        generateAndIngest,
      },
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as CommandExecutorDeps;

    const cmds = new RadioCommands(deps, async () => []);
    expect(await cmds.autoProgram()).toBe(true);
    expect(generateAndIngest).toHaveBeenCalled();
  });

  it("profile aceStepAutoFill false blocks gen even when global autoFill is on", async () => {
    const generateAndIngest = vi.fn();
    const deps = {
      config: {
        commandPrefix: "!",
        aceStepAutoFill: true,
        aceStepEnabled: true,
        aceStepUrl: "http://x",
        radio: {
          enabled: true,
          activeProfile: "focus",
          profiles: {
            focus: {
              name: "focus",
              music: { seedQueries: [], aceStepAutoFill: false },
            },
          },
        },
      },
      queue: mockQueue(),
      player: { resetFailures: vi.fn(), getState: () => "idle" },
      playback: {
        resolveAndPlay: vi.fn(),
        searchFirst: vi.fn(async () => null),
      },
      getProvider: vi.fn(() => ({
        platform: "local",
        search: vi.fn(async () => ({ songs: [], playlists: [], albums: [] })),
      })),
      generateProvider: {
        isConfigured: () => true,
        isBusy: () => false,
        generateAndIngest,
      },
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as CommandExecutorDeps;

    const cmds = new RadioCommands(deps, async () => []);
    expect(await cmds.autoProgram()).toBe(false);
    expect(generateAndIngest).not.toHaveBeenCalled();
  });
});

describe("diversifyArtists", () => {
  it("caps tracks per artist and avoids back-to-back same artist when possible", () => {
    const pool = [
      song({ id: "a1", name: "A1", artist: "Alpha" }),
      song({ id: "a2", name: "A2", artist: "Alpha" }),
      song({ id: "a3", name: "A3", artist: "Alpha" }),
      song({ id: "b1", name: "B1", artist: "Beta" }),
      song({ id: "c1", name: "C1", artist: "Gamma" }),
    ];
    // Deterministic rng: always pick first option in shuffle → stable keys order
    let i = 0;
    const rng = () => {
      i += 1;
      return 0; // Fisher–Yates with 0 keeps original order
    };
    const out = diversifyArtists(pool, { maxPerArtist: 2, rng });
    const alpha = out.filter((s) => artistDiversityKey(s) === "alpha");
    expect(alpha.length).toBeLessThanOrEqual(2);
    expect(out.length).toBe(4); // 2 Alpha + Beta + Gamma
    // No three Alphas
    expect(out.map((s) => s.id)).not.toContain("a3");
  });

  it("empty artist falls back to id key (each track unique)", () => {
    const pool = [
      song({ id: "x", name: "X", artist: "" }),
      song({ id: "y", name: "Y", artist: "" }),
    ];
    const out = diversifyArtists(pool, { maxPerArtist: 1, rng: () => 0 });
    expect(out).toHaveLength(2);
  });
});
