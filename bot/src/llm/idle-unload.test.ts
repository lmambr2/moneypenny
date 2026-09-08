import { describe, expect, it, vi } from "vitest";
import { LlmIdleUnloader } from "./idle-unload.js";

function makeUnloader(seconds = 900) {
  const unload = vi.fn(async () => {});
  const warm = vi.fn(async () => {});
  const u = new LlmIdleUnloader({
    getSeconds: () => seconds,
    unload,
    warm,
  });
  return { u, unload, warm };
}

describe("LlmIdleUnloader", () => {
  it("unloads after the empty-channel timer, not immediately", async () => {
    vi.useFakeTimers();
    const { u, unload, warm } = makeUnloader(900);
    u.onHumanCount(0);
    expect(unload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(899_000);
    expect(unload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(unload).toHaveBeenCalledOnce();
    expect(warm).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("cancels the timer when a human joins before it fires", async () => {
    vi.useFakeTimers();
    const { u, unload, warm } = makeUnloader(900);
    u.onHumanCount(0);
    await vi.advanceTimersByTimeAsync(60_000);
    u.onHumanCount(1);
    await vi.advanceTimersByTimeAsync(900_000);
    expect(unload).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("warms again when someone joins after unload", async () => {
    vi.useFakeTimers();
    const { u, unload, warm } = makeUnloader(15);
    u.onHumanCount(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(unload).toHaveBeenCalledOnce();
    u.onHumanCount(2);
    expect(warm).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("does not restart the timer on repeated empty polls", async () => {
    vi.useFakeTimers();
    const { u, unload } = makeUnloader(10);
    u.onHumanCount(0);
    await vi.advanceTimersByTimeAsync(5_000);
    u.onHumanCount(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(unload).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("does nothing when idle unload is disabled", async () => {
    vi.useFakeTimers();
    const { u, unload, warm } = makeUnloader(0);
    u.onHumanCount(0);
    await vi.advanceTimersByTimeAsync(60_000);
    u.onHumanCount(1);
    expect(unload).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("re-warms if a human joins while unload is in flight", async () => {
    vi.useFakeTimers();
    let finishUnload: () => void = () => {};
    const unload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishUnload = resolve;
        }),
    );
    const warm = vi.fn(async () => {});
    const u = new LlmIdleUnloader({
      getSeconds: () => 1,
      unload,
      warm,
    });
    u.onHumanCount(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(unload).toHaveBeenCalledOnce();
    u.onHumanCount(1);
    finishUnload();
    await Promise.resolve();
    await Promise.resolve();
    expect(warm).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
