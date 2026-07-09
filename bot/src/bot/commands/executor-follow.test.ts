import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BotConfig } from "../../data/config.js";
import { CommandExecutor } from "./executor.js";

function makeExecutor(opts?: {
  getClientChannelId?: (clid: number) => Promise<bigint | null>;
  getChannelId?: () => bigint;
  joinChannelById?: (channelId: bigint) => Promise<boolean>;
}) {
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
      getClientChannelId: opts?.getClientChannelId ?? vi.fn(async () => 42n),
      getChannelId: opts?.getChannelId ?? vi.fn(() => 0n),
      joinChannelById: opts?.joinChannelById ?? vi.fn(async () => true),
      moveClientToChannel: vi.fn(),
      listClientsInCurrentChannel: vi.fn().mockResolvedValue([]),
    },
    isConnected: () => true,
    playNext: vi.fn(),
    getProvider: vi.fn(),
  });
}

describe("CommandExecutor — follow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("moves the bot to the invoker channel", async () => {
    const joinChannelById = vi.fn(async () => true);
    const ex = makeExecutor({ joinChannelById });
    const out = await ex.execute(
      { name: "follow", args: "", rawArgs: [], flags: new Set() },
      {
        invokerName: "Alice",
        invokerId: "110",
        invokerUid: "uid-alice",
        message: "!follow",
        targetMode: 2,
      },
    );
    expect(joinChannelById).toHaveBeenCalledWith(42n);
    expect(out).toContain("Following you");
  });

  it("reports when already in the invoker channel", async () => {
    const ex = makeExecutor({ getChannelId: () => 42n });
    const out = await ex.execute(
      { name: "follow", args: "", rawArgs: [], flags: new Set() },
      {
        invokerName: "Alice",
        invokerId: "110",
        invokerUid: "uid-alice",
        message: "!follow",
        targetMode: 2,
      },
    );
    expect(out).toContain("Already in your channel");
  });

  it("requires a TeamSpeak message context", async () => {
    const ex = makeExecutor();
    const out = await ex.execute({ name: "follow", args: "", rawArgs: [], flags: new Set() });
    expect(out).toContain("TeamSpeak");
  });
});
