import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdlePoller } from "./idle-poller.js";

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
      tsClient: { getClientsInChannel: vi.fn().mockResolvedValue([{ uid: "bot" }]) },
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
        getClientsInChannel: vi.fn().mockImplementation(async () => {
          const clients = [{ uid: "bot" }];
          for (let i = 0; i < humans; i++) clients.push({ uid: `u${i}` } as any);
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
