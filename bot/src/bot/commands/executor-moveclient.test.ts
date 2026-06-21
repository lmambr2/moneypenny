import { describe, it, expect, vi, beforeEach } from "vitest";
import { CommandExecutor } from "./executor.js";
import type { BotConfig } from "../../data/config.js";

function makeExecutor(moveClientToChannel = vi.fn().mockResolvedValue("Moved Bond → Briefing Room.")) {
  const config = { commandPrefix: "!" } as BotConfig;
  return new CommandExecutor({
    playback: {} as any,
    player: {} as any,
    queue: { current: () => null } as any,
    config,
    profileManager: {} as any,
    tsClient: {
      getClientsInChannel: vi.fn(),
      joinChannel: vi.fn(),
      getClientChannelId: vi.fn(),
      getChannelId: vi.fn(() => 0n),
      joinChannelById: vi.fn(),
      moveClientToChannel,
      listClientsInCurrentChannel: vi.fn().mockResolvedValue([]),
    },
    isConnected: () => true,
    playNext: vi.fn(),
    getProvider: vi.fn(),
  });
}

describe("CommandExecutor — moveclient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns usage when args are missing", async () => {
    const ex = makeExecutor();
    const out = await ex.execute({ name: "moveclient", args: "", rawArgs: [], flags: new Set() });
    expect(out).toMatch(/Usage:.*moveclient/i);
  });

  it("delegates to tsClient.moveClientToChannel", async () => {
    const move = vi.fn().mockResolvedValue("Moved Bond → Briefing Room.");
    const ex = makeExecutor(move);
    const out = await ex.execute({
      name: "moveclient",
      args: "Bond Briefing Room",
      rawArgs: ["Bond", "Briefing", "Room"],
      flags: new Set(),
    });
    expect(move).toHaveBeenCalledWith("Bond", "Briefing Room");
    expect(out).toBe("Moved Bond → Briefing Room.");
  });

  it("rate-limits rapid moveclient calls", async () => {
    const ex = makeExecutor();
    const cmd = {
      name: "moveclient",
      args: "Bond Briefing",
      rawArgs: ["Bond", "Briefing"],
      flags: new Set<string>(),
    };
    for (let i = 0; i < 5; i++) {
      const out = await ex.execute(cmd);
      expect(out).not.toMatch(/Too many moves/i);
    }
    const blocked = await ex.execute(cmd);
    expect(blocked).toMatch(/Too many moves/i);
  });
});