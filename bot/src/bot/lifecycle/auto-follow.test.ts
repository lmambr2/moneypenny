import { describe, expect, it, vi } from "vitest";
import type { BotConfig } from "../../data/config.js";
import type { Logger } from "../../logger.js";
import { AutoFollow, type AutoFollowDeps } from "./auto-follow.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
} as unknown as Logger;

const LOBBY = 10n;
const OPS = 20n;
const AFK = 99n;

const row = (id: number, channelID: bigint, type = 0) => ({ id, channelID, type });

function make(
  over: {
    clients?: Array<{ id: number; channelID: bigint; type?: number }>;
    config?: Partial<BotConfig>;
    currentChannel?: bigint;
    joinOk?: boolean;
    now?: () => number;
  } = {},
) {
  const joinChannelById = vi.fn(async () => over.joinOk ?? true);
  const tsClient = {
    getAllClients: vi.fn(async () => over.clients ?? []),
    getClientId: () => 1,
    getChannelId: () => over.currentChannel ?? LOBBY,
    joinChannelById,
    // "AFK" is the only name that resolves in these tests.
    resolveChannelIdByName: vi.fn(async (n: string) => (n.toLowerCase() === "afk" ? AFK : null)),
  };
  const config = {
    autoFollowEnabled: true,
    autoFollowAfkChannels: ["AFK"],
    autoFollowCooldownSec: 60,
    ...over.config,
  } as unknown as BotConfig;

  const follow = new AutoFollow({
    config,
    logger: silentLogger,
    tsClient,
    isConnected: () => true,
    now: over.now,
  } as unknown as AutoFollowDeps);

  return { follow, tsClient, joinChannelById, config };
}

describe("AutoFollow", () => {
  it("moves to the busiest channel when its own is empty", async () => {
    const { follow, joinChannelById } = make({
      clients: [row(2, OPS), row(3, OPS), row(4, 30n), row(1, LOBBY)],
    });
    expect(await follow.maybeFollow(0)).toBe(OPS);
    expect(joinChannelById).toHaveBeenCalledWith(OPS);
  });

  // The bot must never wander off mid-song while people are listening to it.
  it("stays put while it still has company", async () => {
    const { follow, joinChannelById } = make({ clients: [row(2, OPS), row(3, LOBBY)] });
    expect(await follow.maybeFollow(1)).toBeNull();
    expect(joinChannelById).not.toHaveBeenCalled();
  });

  it("does nothing when disabled", async () => {
    const { follow, joinChannelById } = make({
      clients: [row(2, OPS)],
      config: { autoFollowEnabled: false } as Partial<BotConfig>,
    });
    expect(await follow.maybeFollow(0)).toBeNull();
    expect(joinChannelById).not.toHaveBeenCalled();
  });

  it("never follows people into AFK", async () => {
    const { follow, joinChannelById } = make({ clients: [row(2, AFK), row(3, AFK), row(4, AFK)] });
    expect(await follow.maybeFollow(0)).toBeNull();
    expect(joinChannelById).not.toHaveBeenCalled();
  });

  it("picks a real channel over a busier AFK", async () => {
    const { follow } = make({ clients: [row(2, AFK), row(3, AFK), row(4, AFK), row(5, OPS)] });
    expect(await follow.maybeFollow(0)).toBe(OPS);
  });

  it("stays put when the server is empty", async () => {
    const { follow, joinChannelById } = make({ clients: [] });
    expect(await follow.maybeFollow(0)).toBeNull();
    expect(joinChannelById).not.toHaveBeenCalled();
  });

  it("rate-limits itself so it cannot hop every poll", async () => {
    let t = 1_000_000;
    const { follow, joinChannelById } = make({
      clients: [row(2, OPS)],
      now: () => t,
    });
    expect(await follow.maybeFollow(0)).toBe(OPS);
    t += 30_000; // still inside the 60s cooldown
    expect(await follow.maybeFollow(0)).toBeNull();
    expect(joinChannelById).toHaveBeenCalledTimes(1);
    t += 31_000; // past it
    expect(await follow.maybeFollow(0)).toBe(OPS);
    expect(joinChannelById).toHaveBeenCalledTimes(2);
  });

  // A refused join must not start the cooldown, or one full channel would block
  // following for a minute.
  it("does not start the cooldown when the join is refused", async () => {
    let t = 1_000_000;
    const { follow, joinChannelById } = make({
      clients: [row(2, OPS)],
      joinOk: false,
      now: () => t,
    });
    expect(await follow.maybeFollow(0)).toBeNull();
    t += 1_000;
    await follow.maybeFollow(0);
    expect(joinChannelById).toHaveBeenCalledTimes(2);
  });

  it("survives a client-list failure", async () => {
    const { follow } = make();
    (follow as unknown as { deps: AutoFollowDeps }).deps.tsClient.getAllClients = vi.fn(
      async () => {
        throw new Error("ts down");
      },
    );
    await expect(follow.maybeFollow(0)).resolves.toBeNull();
  });

  it("survives a join throwing", async () => {
    const { follow, tsClient } = make({ clients: [row(2, OPS)] });
    tsClient.joinChannelById = vi.fn(async () => {
      throw new Error("no such channel");
    });
    await expect(follow.maybeFollow(0)).resolves.toBeNull();
  });

  it("resolves AFK names once and reuses the result", async () => {
    let t = 1_000_000;
    const { follow, tsClient } = make({ clients: [row(2, OPS)], now: () => t });
    await follow.maybeFollow(0);
    t += 120_000;
    await follow.maybeFollow(0);
    expect(tsClient.resolveChannelIdByName).toHaveBeenCalledTimes(1);
  });

  it("ignores AFK names that do not resolve to a channel", async () => {
    const { follow } = make({
      clients: [row(2, OPS)],
      config: { autoFollowAfkChannels: ["Nonexistent"] } as unknown as Partial<BotConfig>,
    });
    expect(await follow.maybeFollow(0)).toBe(OPS);
  });
});
