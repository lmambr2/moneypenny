import { describe, expect, it, vi } from "vitest";
import type { Song } from "../../music/provider.js";
import type { CommandExecutorDeps } from "./executor.js";
import {
  isRadioSeedFriendlySong,
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
    const search = vi.fn(async (q: string, _limit?: number) => {
      const ql = q.toLowerCase();
      const songs = !ql
        ? library
        : library.filter(
            (s) => s.name.toLowerCase().includes(ql) || s.artist.toLowerCase().includes(ql),
          );
      return { songs, playlists: [], albums: [] };
    });
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
              music: { seedQueries: ["synthwave"], shuffle: true },
            },
          },
        },
      },
      queue: {
        clear: vi.fn(),
        add: vi.fn((s: Song) => added.push(s.id)),
        play: vi.fn(() => library[1]),
        size: () => added.length,
      },
      player: { resetFailures: vi.fn(), getState: () => "idle" },
      playback: { resolveAndPlay: vi.fn(async () => true), searchFirst: vi.fn() },
      getProvider: vi.fn(() => ({ platform: "local", search })),
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    } as unknown as CommandExecutorDeps;

    const cmds = new RadioCommands(deps, async () => []);
    const ok = await cmds.autoProgram();
    expect(ok).toBe(true);
    expect(added).not.toContain("mix");
    expect(added.length).toBeGreaterThanOrEqual(2);
    expect(search).toHaveBeenCalled();
    // Must not have used YouTube fallback path (searchFirst)
    expect(deps.playback.searchFirst).not.toHaveBeenCalled();
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
