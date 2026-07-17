import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { applyDeterministicGates } from "./deterministic-gates.js";
import type { RouterContext } from "./router.js";

function ctx(
  partial: Partial<RouterContext> & { connected?: boolean; demo?: boolean },
): RouterContext {
  return {
    bot: {
      isConnected: () => partial.connected !== false,
      isDemoTestPlaying: () => !!partial.demo,
    } as any,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Logger,
    canRun: partial.canRun,
    ...partial,
  };
}

const log = { debug: vi.fn(), info: vi.fn() } as unknown as Logger;

describe("applyDeterministicGates", () => {
  it("denies by rights", () => {
    const msg = applyDeterministicGates(
      { name: "stop", args: "", rawArgs: [], flags: new Set() },
      ctx({ canRun: () => false }),
      log,
    );
    expect(msg).toMatch(/permission/i);
  });

  it("blocks audio commands when disconnected", () => {
    const msg = applyDeterministicGates(
      { name: "skip", args: "", rawArgs: [], flags: new Set() },
      ctx({ connected: false }),
      log,
    );
    expect(msg).toMatch(/not connected/i);
  });

  it("blocks demo interrupt without test.skip", () => {
    const msg = applyDeterministicGates(
      { name: "skip", args: "", rawArgs: [], flags: new Set() },
      ctx({
        demo: true,
        canRun: (t) => t !== "test.skip",
      }),
      log,
    );
    expect(msg).toMatch(/Chairman|server admin/i);
  });

  it("allows radio status without radio.power", () => {
    const msg = applyDeterministicGates(
      { name: "radio", args: "", rawArgs: [], flags: new Set() },
      ctx({ canRun: (t) => t === "radio" }),
      log,
    );
    expect(msg).toBeNull();
  });

  it("denies radio on without radio.power", () => {
    const msg = applyDeterministicGates(
      { name: "radio", args: "on", rawArgs: ["on"], flags: new Set() },
      ctx({ canRun: (t) => t === "radio" }),
      log,
    );
    expect(msg).toMatch(/radio\.power/);
  });
});
