import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { TagStore } from "../../radio/index.js";
import { CommandExecutor } from "./executor.js";

function harness(opts: { playerState?: "idle" | "playing" } = {}) {
  const tagStore = new TagStore({ db: new Database(":memory:") });
  tagStore.upsert("k1", { genre: "ambient", bpm: 90 }, "analyzer");
  tagStore.upsert("k2", { genre: "ambient", bpm: 100 }, "analyzer");
  tagStore.upsert("k3", { genre: "dnb", bpm: 174 }, "analyzer");

  const queued: unknown[] = [];
  const queue = {
    add: vi.fn((s: unknown) => queued.push(s) - 1),
    play: vi.fn(),
    playAt: vi.fn(),
    current: vi.fn(() => queued[0] ?? null),
  };
  const resolveAndPlay = vi.fn(async () => true);
  const local = {
    getSongDetail: vi.fn(async (id: string) =>
      id === "k3"
        ? null
        : { id, name: id, artist: "A", album: "", duration: 1, coverUrl: "", platform: "local" },
    ),
  };
  const ex = new CommandExecutor({
    playback: { resolveAndPlay } as never,
    player: { getState: () => opts.playerState ?? "playing", resetFailures: vi.fn() } as never,
    queue: queue as never,
    config: { commandPrefix: "!" } as never,
    profileManager: {} as never,
    tsClient: {} as never,
    isConnected: () => true,
    playNext: vi.fn(),
    getProvider: vi.fn(() => local as never),
    tagStore,
  });
  return { ex, queue, queued, resolveAndPlay };
}

const run = (ex: CommandExecutor, filters: unknown) =>
  ex.execute({
    name: "selecttracks",
    args: JSON.stringify(filters),
    rawArgs: [],
    flags: new Set(),
  });

describe("cmdSelectTracks", () => {
  it("queues matching local tracks and reports the count", async () => {
    const { ex, queued } = harness();
    const out = await run(ex, { genreAny: ["ambient"] });
    expect(out).toBe("Queued 2 tracks by tags.");
    expect(queued.map((s) => (s as { id: string }).id).sort()).toEqual(["k1", "k2"]);
  });

  it("starts playback at the inserted tracks when the player was idle", async () => {
    const { ex, queue, resolveAndPlay } = harness({ playerState: "idle" });
    await run(ex, { genreAny: ["ambient"] });
    // playAt(first insert index), not play(): play() restarts at index 0,
    // which can replay an old/radio-fill track instead of the selection.
    expect(queue.playAt).toHaveBeenCalledWith(0);
    expect(resolveAndPlay).toHaveBeenCalled();
  });

  it("does not interrupt playing music", async () => {
    const { ex, queue, resolveAndPlay } = harness({ playerState: "playing" });
    await run(ex, { genreAny: ["ambient"] });
    expect(queue.play).not.toHaveBeenCalled();
    expect(queue.playAt).not.toHaveBeenCalled();
    expect(resolveAndPlay).not.toHaveBeenCalled();
  });

  it("skips stale overlay rows whose file no longer resolves", async () => {
    const { ex } = harness();
    expect(await run(ex, { genreAny: ["dnb"] })).toBe("No tracks match those tags."); // k3 resolves null
  });

  it("reports no matches and rejects malformed JSON", async () => {
    const { ex } = harness();
    expect(await run(ex, { mood: ["nonexistent"] })).toBe("No tracks match those tags.");
    expect(
      await ex.execute({ name: "selecttracks", args: "{nope", rawArgs: [], flags: new Set() }),
    ).toContain("Usage:");
  });
});
