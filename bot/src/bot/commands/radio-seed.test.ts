import { describe, expect, it, vi } from "vitest";
import type { Song } from "../../music/provider.js";
import type { CommandExecutorDeps } from "./executor.js";
import {
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
    const added: Array<{ id: string; platform?: string }> = [];
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
      queue: {
        clear: vi.fn(),
        add: vi.fn((s: Song) => added.push({ id: s.id, platform: s.platform })),
        play: vi.fn(() => library[1]),
        size: () => added.length,
      },
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
    const added: string[] = [];
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
      queue: {
        clear: vi.fn(),
        add: vi.fn((s: Song) => added.push(s.id)),
        play: vi.fn(() => library[0]),
        size: () => added.length,
      },
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
    expect(added).toEqual(["s1"]);
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
      queue: {
        clear: vi.fn(),
        add: vi.fn(),
        play: vi.fn(() => genSong),
        size: () => 0,
      },
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
      queue: { clear: vi.fn(), add: vi.fn(), play: vi.fn(), size: () => 0 },
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
