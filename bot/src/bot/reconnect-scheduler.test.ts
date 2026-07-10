import { afterEach, describe, expect, it, vi } from "vitest";
import { ReconnectScheduler, reconnectDelayMs } from "./reconnect-scheduler.js";

describe("reconnectDelayMs", () => {
  it("grows exponentially and caps", () => {
    expect(reconnectDelayMs(1, 2000, 60_000)).toBe(2000);
    expect(reconnectDelayMs(2, 2000, 60_000)).toBe(4000);
    expect(reconnectDelayMs(3, 2000, 60_000)).toBe(8000);
    expect(reconnectDelayMs(10, 2000, 60_000)).toBe(60_000);
  });
});

describe("ReconnectScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules reconnect after base delay", async () => {
    vi.useFakeTimers();
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const s = new ReconnectScheduler({
      reconnect,
      baseMs: 2000,
      maxMs: 60_000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });

    s.schedule("a", "drop");
    expect(reconnect).not.toHaveBeenCalled();
    expect(s.isBusy("a")).toBe(true);

    await vi.advanceTimersByTimeAsync(1999);
    expect(reconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledWith("a");
    // success clears attempts
    expect(s.getAttempt("a")).toBe(0);
    expect(s.isBusy("a")).toBe(false);
  });

  it("single-flight: second schedule while pending is ignored", async () => {
    vi.useFakeTimers();
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const s = new ReconnectScheduler({
      reconnect,
      baseMs: 1000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });

    s.schedule("a");
    s.schedule("a");
    s.schedule("a");
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("increases backoff on failed attempts that reschedule", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const reconnect = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new Error("fail");
    });
    const s = new ReconnectScheduler({
      reconnect,
      baseMs: 1000,
      maxMs: 8000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });

    s.schedule("b");
    await vi.advanceTimersByTimeAsync(1000); // attempt 1 fails → reschedule
    expect(reconnect).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000); // attempt 2 delay
    expect(reconnect).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(4000); // attempt 3
    expect(reconnect).toHaveBeenCalledTimes(3);
    expect(s.getAttempt("b")).toBe(0);
  });

  it("cancel prevents the pending timer from firing", async () => {
    vi.useFakeTimers();
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const s = new ReconnectScheduler({
      reconnect,
      baseMs: 5000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });

    s.schedule("c");
    s.cancel("c");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconnect).not.toHaveBeenCalled();
    expect(s.isBusy("c")).toBe(false);
  });

  it("reset after success clears backoff", async () => {
    vi.useFakeTimers();
    const reconnect = vi.fn().mockResolvedValue(undefined);
    const s = new ReconnectScheduler({
      reconnect,
      baseMs: 1000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });

    s.schedule("d");
    await vi.advanceTimersByTimeAsync(1000);
    s.reset("d");
    s.schedule("d");
    // next attempt should use base delay again (attempt 1)
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconnect).toHaveBeenCalledTimes(2);
  });

  it("cancel during in-flight reconnect prevents retry-after-fail reschedule", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reconnect = vi.fn().mockImplementation(async () => {
      await gate;
      throw new Error("still down");
    });
    const s = new ReconnectScheduler({
      reconnect,
      baseMs: 1000,
      setTimeoutFn: setTimeout,
      clearTimeoutFn: clearTimeout,
    });

    s.schedule("e");
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconnect).toHaveBeenCalledTimes(1);
    // Operator stop while startBot still running
    s.cancel("e");
    release();
    await Promise.resolve();
    await Promise.resolve();
    // Advance past any retry-after-fail base delay
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(s.isBusy("e")).toBe(false);
  });
});
