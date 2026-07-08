import { afterEach, describe, expect, it, vi } from "vitest";
import { schedulePhase0AutoPlay } from "./phase0.js";

describe("schedulePhase0AutoPlay", () => {
  const env = process.env;

  afterEach(() => {
    process.env = { ...env };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does nothing when neither PHASE0_TEST_PLAY nor PHASE0_AUTO_TEST is set", () => {
    delete process.env.PHASE0_TEST_PLAY;
    delete process.env.PHASE0_AUTO_TEST;
    process.env.TS6_HOST = "teamspeak.example";
    const info = vi.fn();
    schedulePhase0AutoPlay({
      logger: { info, warn: vi.fn(), error: vi.fn() } as never,
      executeCommand: vi.fn(),
    });
    expect(info).not.toHaveBeenCalled();
  });

  it("does nothing when PHASE0_TEST_PLAY is empty", () => {
    process.env.PHASE0_TEST_PLAY = "   ";
    const info = vi.fn();
    schedulePhase0AutoPlay({
      logger: { info, warn: vi.fn(), error: vi.fn() } as never,
      executeCommand: vi.fn(),
    });
    expect(info).not.toHaveBeenCalled();
  });

  it("runs !test when PHASE0_AUTO_TEST=1", async () => {
    vi.useFakeTimers();
    delete process.env.PHASE0_TEST_PLAY;
    process.env.PHASE0_AUTO_TEST = "1";
    const info = vi.fn();
    const executeCommand = vi.fn().mockResolvedValue("Now playing: demo (local)");
    schedulePhase0AutoPlay({
      logger: { info, warn: vi.fn(), error: vi.fn() } as never,
      executeCommand,
    });
    expect(info).toHaveBeenCalledWith(expect.stringContaining("auto !test"));
    await vi.advanceTimersByTimeAsync(4000);
    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: "test" }),
    );
  });

  it("schedules explicit track when PHASE0_TEST_PLAY is set", async () => {
    vi.useFakeTimers();
    process.env.PHASE0_TEST_PLAY = "https://www.youtube.com/watch?v=test";
    const executeCommand = vi.fn().mockResolvedValue("Now playing: test");
    schedulePhase0AutoPlay({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      executeCommand,
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: "play", args: "https://www.youtube.com/watch?v=test" }),
    );
  });
});