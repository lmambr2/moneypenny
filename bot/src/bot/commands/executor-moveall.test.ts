import { describe, it, expect, vi, beforeEach } from "vitest";
import { CommandExecutor } from "./executor.js";
import type { BotConfig } from "../../data/config.js";
import type { TS3TextMessage } from "../../ts-protocol/client.js";

function makeExecutor(overrides: Partial<{
  listClientsInCurrentChannel: () => Promise<{ clid: number; nickname: string }[]>;
  moveClientToChannel: (t: string, c: string) => Promise<string>;
}> = {}) {
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
      moveClientToChannel: vi.fn().mockResolvedValue("Moved X → Y."),
      listClientsInCurrentChannel: vi.fn().mockResolvedValue([
        { clid: 10, nickname: "Bond" },
        { clid: 11, nickname: "Q" },
      ]),
      ...overrides,
    },
    isConnected: () => true,
    playNext: vi.fn(),
    getProvider: vi.fn(),
  });
}

const msg = { invokerUid: "uid-admin" } as TS3TextMessage;

describe("CommandExecutor — moveall", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stages a mass move and requires confirm", async () => {
    const ex = makeExecutor();
    const out = await ex.execute({
      name: "moveall",
      args: "Briefing Room",
      rawArgs: ["Briefing", "Room"],
      flags: new Set(),
    }, msg);
    expect(out).toMatch(/Move 2 client/i);
    expect(out).toMatch(/confirm within 30/i);
  });

  it("executes after confirm", async () => {
    const move = vi.fn().mockResolvedValue("Moved Bond → Briefing Room.");
    const ex = makeExecutor({ moveClientToChannel: move });
    await ex.execute({
      name: "moveall",
      args: "Briefing",
      rawArgs: ["Briefing"],
      flags: new Set(),
    }, msg);
    const out = await ex.execute({
      name: "moveall",
      args: "confirm",
      rawArgs: ["confirm"],
      flags: new Set(),
    }, msg);
    expect(move).toHaveBeenCalledTimes(2);
    expect(out).toMatch(/Mass move complete: 2\/2/i);
  });
});