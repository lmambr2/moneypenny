/**
 * In-repo substitute for R-live ops smoke: drives real RadioCommands
 * !radio ops / status paths (not a re-implementation).
 */

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { defaultRadioConfig } from "../../radio/index.js";
import { TagStore } from "../../radio/tag-store.js";
import { CommandExecutor } from "./executor.js";

async function run(ex: CommandExecutor, args: string[]) {
  return ex.execute(
    { name: "radio", args: args.join(" "), rawArgs: args, flags: new Set() },
    undefined,
  );
}

describe("R-live substitute: !radio ops / status", () => {
  it("status and ops list work on real executor path", async () => {
    const radio = defaultRadioConfig();
    radio.enabled = true;
    const tagStore = new TagStore({ db: new Database(":memory:") });
    const ex = new CommandExecutor({
      playback: {
        resolveAndPlay: vi.fn(async () => true),
        extractId: (s: string) => s,
        searchFirst: vi.fn(async () => null),
      } as never,
      player: { getState: () => "idle", resetFailures: vi.fn() } as never,
      queue: {
        clear: vi.fn(),
        add: vi.fn(),
        play: vi.fn(),
        current: vi.fn(() => null),
      } as never,
      config: { commandPrefix: "!", radio } as never,
      profileManager: {} as never,
      tsClient: {} as never,
      isConnected: () => true,
      playNext: vi.fn(),
      getProvider: vi.fn(() => ({
        platform: "local",
        getPlaylistSongs: async () => [],
        search: async () => ({ songs: [], playlists: [], albums: [] }),
        getSongDetail: async () => null,
      })) as never,
      tagStore,
      radio: {
        cueBumper: vi.fn(async () => "cued" as const),
        cueSay: vi.fn(async () => "cued" as const),
        skipBumper: vi.fn(() => "next" as const),
        onTrackBoundary: vi.fn(async () => "advanced" as const),
        status: () => ({ songsUntilBumper: 2, cuePending: false, skipNextPending: false }),
      },
    });

    const status = await run(ex, ["status"]);
    expect(status).toMatch(/radio|on|profile|lobby/i);

    const list = await run(ex, ["ops", "list"]);
    expect(list).toMatch(/lobby|focus|profile/i);

    const ops = await run(ex, ["ops", "focus"]);
    expect(radio.activeProfile).toBe("focus");
    expect(ops).toMatch(/focus|op context|retuned|programmed/i);
  });
});
