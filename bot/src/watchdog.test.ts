import { describe, expect, it, vi } from "vitest";
import { Watchdog, type WatchdogTarget } from "./watchdog.js";

function fakeLogger(): any {
  const l: any = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  l.child = () => l;
  return l;
}

function target(
  id: string,
  connected: boolean,
  reconnect = vi.fn().mockResolvedValue(undefined),
): WatchdogTarget & { reconnect: any } {
  return { id, name: id, isConnected: () => connected, reconnect };
}

describe("Watchdog — reconnection", () => {
  it("reconnects a disconnected target", async () => {
    const t = target("a", false);
    const wd = new Watchdog({ getTargets: () => [t], logger: fakeLogger() });
    await wd.tick();
    expect(t.reconnect).toHaveBeenCalledTimes(1);
  });

  it("leaves connected targets alone", async () => {
    const t = target("a", true);
    const wd = new Watchdog({ getTargets: () => [t], logger: fakeLogger() });
    await wd.tick();
    expect(t.reconnect).not.toHaveBeenCalled();
  });

  it("respects the per-target reconnect cooldown", async () => {
    const t = target("a", false);
    let clock = 1_000_000;
    const wd = new Watchdog({
      getTargets: () => [t],
      logger: fakeLogger(),
      reconnectCooldownMs: 60_000,
      now: () => clock,
    });
    await wd.tick();
    await wd.tick(); // immediately again — within cooldown
    expect(t.reconnect).toHaveBeenCalledTimes(1);
    clock += 60_001; // past cooldown
    await wd.tick();
    expect(t.reconnect).toHaveBeenCalledTimes(2);
  });

  it("resets the cooldown once a target recovers", async () => {
    let connected = false;
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const t: WatchdogTarget = { id: "a", isConnected: () => connected, reconnect };
    let clock = 0;
    const wd = new Watchdog({
      getTargets: () => [t],
      logger: fakeLogger(),
      reconnectCooldownMs: 60_000,
      now: () => clock,
    });

    await wd.tick(); // disconnected → attempt 1
    connected = true;
    await wd.tick(); // healthy → backoff cleared
    connected = false;
    clock += 1; // well within cooldown, but backoff was reset
    await wd.tick(); // disconnected again → attempt immediately
    expect(reconnect).toHaveBeenCalledTimes(2);
  });

  it("keeps going if one reconnect throws", async () => {
    const bad = target("bad", false, vi.fn().mockRejectedValue(new Error("nope")));
    const good = target("good", false);
    const wd = new Watchdog({ getTargets: () => [bad, good], logger: fakeLogger() });
    await wd.tick();
    expect(good.reconnect).toHaveBeenCalledTimes(1);
  });
});

describe("Watchdog — memory ceiling", () => {
  it("fires onMemoryExceeded above the limit", async () => {
    const onMemoryExceeded = vi.fn();
    const wd = new Watchdog({
      getTargets: () => [],
      logger: fakeLogger(),
      memoryLimitMb: 100,
      memoryUsage: () => 150 * 1024 * 1024,
      onMemoryExceeded,
    });
    await wd.tick();
    expect(onMemoryExceeded).toHaveBeenCalledWith(150);
  });

  it("does not fire below the limit or when disabled", async () => {
    const onMemoryExceeded = vi.fn();
    const under = new Watchdog({
      getTargets: () => [],
      logger: fakeLogger(),
      memoryLimitMb: 100,
      memoryUsage: () => 50 * 1024 * 1024,
      onMemoryExceeded,
    });
    await under.tick();
    const disabled = new Watchdog({
      getTargets: () => [],
      logger: fakeLogger(),
      memoryLimitMb: 0,
      memoryUsage: () => 9_999 * 1024 * 1024,
      onMemoryExceeded,
    });
    await disabled.tick();
    expect(onMemoryExceeded).not.toHaveBeenCalled();
  });
});
