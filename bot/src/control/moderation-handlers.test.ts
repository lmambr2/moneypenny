/**
 * G4 — registerBotCommandHandlers mute/kick + router rights gate (fail-closed).
 */
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { registerBotCommandHandlers } from "./register-handlers.js";
import { ControlRouter, type RouterContext } from "./router.js";

function fakeLogger(): Logger {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  l.child.mockReturnValue(l);
  return l as unknown as Logger;
}

describe("registerBotCommandHandlers mute/kick (G4)", () => {
  function wire(moderation: ReturnType<typeof vi.fn>) {
    const router = new ControlRouter(fakeLogger());
    registerBotCommandHandlers(router, {
      commands: { execute: vi.fn() } as never,
      playback: {} as never,
      roast: {} as never,
      memory: {} as never,
      kg: {} as never,
      knowledge: {} as never,
      moderation: moderation as never,
    });
    return router;
  }

  function ctx(canRun?: (c: string) => boolean): RouterContext {
    return {
      bot: { isConnected: () => true } as never,
      logger: fakeLogger(),
      canRun,
    };
  }

  it("mute without target returns usage (handler path)", async () => {
    const moderation = vi.fn();
    const router = wire(moderation);
    const out = await router.execute(
      {
        type: "deterministic",
        command: { name: "mute", args: "", rawArgs: [], flags: new Set() },
      },
      ctx(() => true),
    );
    expect(out).toMatch(/Usage: !mute/i);
    expect(moderation).not.toHaveBeenCalled();
  });

  it("mute passes canRun into host.moderation", async () => {
    const moderation = vi.fn(async () => "ok muted");
    const router = wire(moderation);
    const canRun = vi.fn((c: string) => c === "mute");
    const out = await router.execute(
      {
        type: "deterministic",
        command: { name: "mute", args: "Alice", rawArgs: ["Alice"], flags: new Set() },
      },
      ctx(canRun),
    );
    expect(out).toBe("ok muted");
    expect(moderation).toHaveBeenCalledWith("mute", "Alice", canRun);
  });

  it("router fails closed when canRun denies mute", async () => {
    const moderation = vi.fn();
    const router = wire(moderation);
    const out = await router.execute(
      {
        type: "deterministic",
        command: { name: "mute", args: "Bob", rawArgs: ["Bob"], flags: new Set() },
      },
      ctx(() => false),
    );
    expect(out).toMatch(/permission/i);
    expect(moderation).not.toHaveBeenCalled();
  });

  it("kick fails closed at router when rights deny", async () => {
    const moderation = vi.fn();
    const router = wire(moderation);
    const out = await router.execute(
      {
        type: "deterministic",
        command: { name: "kick", args: "Bob", rawArgs: ["Bob"], flags: new Set() },
      },
      ctx((c) => c !== "kick"),
    );
    expect(out).toMatch(/permission/i);
    expect(moderation).not.toHaveBeenCalled();
  });
});
