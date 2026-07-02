import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { CommandExecutor } from "./executor.js";
import { TagStore } from "../../radio/index.js";

function executor(current: { id: string; name: string } | null, searchHit?: { id: string; name: string }) {
  const tagStore = new TagStore({ db: new Database(":memory:") });
  const ex = new CommandExecutor({
    playback: {
      searchFirst: vi.fn(async () => (searchHit ? { provider: { platform: "local" }, song: searchHit } : null)),
    } as never,
    player: {} as never,
    queue: { current: () => current } as never,
    config: { commandPrefix: "!" } as never,
    profileManager: {} as never,
    tsClient: {} as never,
    isConnected: () => true,
    playNext: vi.fn(),
    getProvider: vi.fn(),
    tagStore,
  });
  return { ex, tagStore };
}

const msg = { invokerUid: "uid-1" } as never;
const run = (ex: CommandExecutor, args: string[]) =>
  ex.execute({ name: args[0], args: args.slice(1).join(" "), rawArgs: args.slice(1), flags: new Set() }, msg);

describe("cmdRate / cmdUnrate", () => {
  it("rates the now-playing track for the invoking user", async () => {
    const { ex, tagStore } = executor({ id: "k", name: "Aurora" });
    const out = await run(ex, ["rate", "4"]);
    expect(out).toContain("Aurora");
    expect(tagStore.getRating("k")).toEqual({ avg: 4, count: 1 });
  });

  it("rates a searched track when a query is given", async () => {
    const { ex, tagStore } = executor(null, { id: "s1", name: "Found" });
    await run(ex, ["rate", "5", "found", "song"]);
    expect(tagStore.getRating("s1")).toEqual({ avg: 5, count: 1 });
  });

  it("shows usage for out-of-range stars", async () => {
    const { ex } = executor({ id: "k", name: "X" });
    expect(await run(ex, ["rate", "9"])).toContain("Usage:");
  });

  it("reports when nothing is playing", async () => {
    const { ex } = executor(null);
    expect(await run(ex, ["rate", "3"])).toMatch(/[Nn]othing/);
  });

  it("unrate removes the invoker's rating", async () => {
    const { ex, tagStore } = executor({ id: "k", name: "Aurora" });
    await run(ex, ["rate", "4"]);
    const out = await run(ex, ["unrate"]);
    expect(out).toContain("Removed");
    expect(tagStore.getRating("k")).toEqual({ avg: 0, count: 0 });
  });
});
