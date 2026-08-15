import { describe, expect, it, vi } from "vitest";
import { CommandExecutor } from "./executor.js";

function executor(): CommandExecutor {
  return new CommandExecutor({
    playback: {} as any,
    player: {} as any,
    queue: {} as any,
    config: { commandPrefix: "!" } as any,
    profileManager: {} as any,
    tsClient: {} as any,
    isConnected: () => true,
    playNext: vi.fn(),
    getProvider: vi.fn(),
  });
}

describe("cmdHelp", () => {
  it("lists AI, memory, roast, and admin commands", async () => {
    const text = await executor().execute({
      name: "help",
      args: "",
      rawArgs: [],
      flags: new Set(),
    });

    expect(text).toContain("!ask");
    expect(text).toContain("!analyst");
    expect(text).toContain("!remember");
    expect(text).toContain("!recall");
    expect(text).toContain("!forget");
    expect(text).toContain("!mine");
    expect(text).toContain("!refine");
    expect(text).toContain("!craft");
    expect(text).toContain("!econ");
    expect(text).toContain("!roast");
    expect(text).toContain("!roastout");
    expect(text).toContain("!reindex");
    expect(text).toContain("!ingeststatus");
    expect(text).toContain("!moveclient");
    expect(text).toContain("!moveall");
    expect(text).toContain("!ban");
    expect(text).toContain("!unban");
    expect(text).toContain("!karaoke");
  });
});
