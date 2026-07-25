import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeakerArmTracker } from "./speaker-arm.js";

describe("SpeakerArmTracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms, isArmed, and expires via onExpire", () => {
    vi.useFakeTimers();
    const onExpire = vi.fn();
    const arm = new SpeakerArmTracker({ listenWindowMs: 1000, onExpire });
    arm.arm(7);
    expect(arm.isArmed(7)).toBe(true);
    expect(arm.anyArmed()).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(onExpire).toHaveBeenCalledWith(7);
    expect(arm.isArmed(7)).toBe(false);
  });

  it("disarm clears without onExpire", () => {
    const onExpire = vi.fn();
    const arm = new SpeakerArmTracker({ listenWindowMs: 5000, onExpire });
    arm.arm(1);
    arm.disarm(1);
    expect(arm.isArmed(1)).toBe(false);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("prune disarms gone clients", () => {
    const arm = new SpeakerArmTracker({ listenWindowMs: 5000, onExpire: () => {} });
    arm.arm(1);
    arm.arm(2);
    const gone = arm.prune(new Set([1]));
    expect(gone).toEqual([2]);
    expect(arm.isArmed(1)).toBe(true);
    expect(arm.isArmed(2)).toBe(false);
  });

  it("dedupes partial routed commands", () => {
    const arm = new SpeakerArmTracker({ listenWindowMs: 5000, onExpire: () => {} });
    arm.arm(3);
    arm.markPartialRouted(3, "pause");
    expect(arm.lastPartialRouted(3)).toBe("pause");
    arm.clearPartialRouted(3);
    expect(arm.lastPartialRouted(3)).toBeUndefined();
  });
});
