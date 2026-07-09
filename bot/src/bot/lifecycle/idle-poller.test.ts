import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countChannelHumans, IdlePoller } from "./idle-poller.js";

describe("countChannelHumans", () => {
  it("excludes query clients and self clid", () => {
    expect(
      countChannelHumans(
        [
          { id: 1, type: 0 }, // bot
          { id: 2, type: 0 }, // human
          { id: 3, type: 1 }, // query
        ],
        1,
      ),
    ).toBe(1);
  });

  it("does not undercount when the bot is missing from the list", () => {
    // Old formula `length - 1` would return 0 here and block bumpers forever.
    expect(countChannelHumans([{ id: 9, type: 0 }], 1)).toBe(1);
  });
});

describe("IdlePoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("disconnects after idle timeout when channel stays empty", async () => {
    const onDisconnect = vi.fn();
    const onPoll = vi.fn();
    const config = { idleTimeoutMinutes: 1 } as any;
    const poller = new IdlePoller({
      config,
      logger: { info: vi.fn() } as any,
      tsClient: {
        getClientsInChannel: vi.fn().mockResolvedValue([{ uid: "bot", id: 1, type: 0 }]),
        getClientId: () => 1,
      },
      isConnected: () => true,
      onDisconnect,
      onPoll,
      pollIntervalMs: 1000,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onPoll).toHaveBeenCalled();
    expect(onDisconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("cancels idle timer when humans return", async () => {
    const onDisconnect = vi.fn();
    let humans = 0;
    const poller = new IdlePoller({
      config: { idleTimeoutMinutes: 1 } as any,
      logger: { info: vi.fn() } as any,
      tsClient: {
        getClientId: () => 1,
        getClientsInChannel: vi.fn().mockImplementation(async () => {
          const clients = [{ uid: "bot", id: 1, type: 0 }];
          for (let i = 0; i < humans; i++)
            clients.push({ uid: `u${i}`, id: 10 + i, type: 0 } as any);
          return clients;
        }),
      },
      isConnected: () => true,
      onDisconnect,
      onPoll: vi.fn(),
      pollIntervalMs: 1000,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(1000);
    humans = 2;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onDisconnect).not.toHaveBeenCalled();
    poller.stop();
  });
});
