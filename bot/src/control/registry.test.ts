import { describe, expect, it, vi } from "vitest";
import { COMMAND_MANIFEST } from "../bot/commands.js";
import type { Logger } from "../logger.js";
import { audioGuard, composeMiddleware, rightsGate } from "./middleware.js";
import { CommandRegistry } from "./registry.js";
import type { RouterContext, RouterDecision } from "./router.js";

function mockCtx(overrides?: Partial<RouterContext>): RouterContext {
  return {
    bot: {
      isConnected: () => true,
    } as any,
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => mockCtx().logger,
    } as unknown as Logger,
    canRun: () => true,
    ...overrides,
  };
}

const emptyDecision: RouterDecision = { type: "deterministic" };

describe("CommandRegistry", () => {
  it("registers handlers and lists names", () => {
    const reg = new CommandRegistry();
    reg.register({
      name: "skip",
      execute: async () => "skipped",
    });
    expect(reg.has("skip")).toBe(true);
    expect(reg.has("SKIP")).toBe(true);
    expect(reg.names()).toContain("skip");
  });

  it("execute runs handler when no middleware", async () => {
    const reg = new CommandRegistry();
    reg.register({
      name: "pause",
      execute: async () => "paused",
    });
    const out = await reg.execute(
      { name: "pause", args: "", rawArgs: [], flags: new Set() },
      mockCtx(),
      emptyDecision,
    );
    expect(out).toBe("paused");
  });

  it("execute returns unknown-command when missing", async () => {
    const reg = new CommandRegistry();
    const out = await reg.execute(
      { name: "nope", args: "", rawArgs: [], flags: new Set() },
      mockCtx(),
      emptyDecision,
    );
    expect(out).toMatch(/Unknown command/);
  });

  it("middleware runs in order before handler", async () => {
    const order: string[] = [];
    const reg = new CommandRegistry();
    reg
      .use(async (_c, _cmd, _d, next) => {
        order.push("a");
        return next();
      })
      .use(async (_c, _cmd, _d, next) => {
        order.push("b");
        return next();
      });
    reg.register({
      name: "now",
      execute: async () => {
        order.push("handler");
        return "ok";
      },
    });
    await reg.execute(
      { name: "now", args: "", rawArgs: [], flags: new Set() },
      mockCtx(),
      emptyDecision,
    );
    expect(order).toEqual(["a", "b", "handler"]);
  });

  it("middleware can short-circuit without calling handler", async () => {
    const reg = new CommandRegistry();
    const handler = vi.fn(async () => "should-not-run");
    reg.use(async () => "blocked");
    reg.register({ name: "stop", execute: handler });
    const out = await reg.execute(
      { name: "stop", args: "", rawArgs: [], flags: new Set() },
      mockCtx(),
      emptyDecision,
    );
    expect(out).toBe("blocked");
    expect(handler).not.toHaveBeenCalled();
  });

  it("toolToCommand maps play + platform flags", () => {
    const reg = new CommandRegistry();
    const cmd = reg.toolToCommand("play", { query: "dragula", platform: "youtube" });
    expect(cmd?.name).toBe("play");
    expect(cmd?.args).toBe("dragula");
    expect(cmd?.flags.has("y")).toBe(true);
  });

  it("toolToCommand uses COMMAND_MANIFEST llmTool aliases (play_music, now_playing)", () => {
    const reg = new CommandRegistry();
    expect(reg.toolToCommand("play_music", { query: "x" })?.name).toBe("play");
    expect(reg.toolToCommand("now_playing", {})?.name).toBe("now");
    expect(reg.toolToCommand("set_volume", { level: 40 })?.name).toBe("vol");
  });

  it("toolToCommand uses llmTool alias when set on a custom spec", () => {
    const reg = new CommandRegistry([
      { name: "play", kind: "resolved", audio: true, llmTool: "play_music" },
    ]);
    const cmd = reg.toolToCommand("play_music", { query: "x" });
    expect(cmd?.name).toBe("play");
    expect(cmd?.args).toBe("x");
  });

  it("rightsToken falls back to command name", () => {
    const reg = new CommandRegistry([
      { name: "ban", kind: "delegated", admin: true },
      { name: "radio", kind: "delegated", rightsToken: "radio.power" },
    ]);
    expect(reg.rightsToken("ban")).toBe("ban");
    expect(reg.rightsToken("radio")).toBe("radio.power");
  });

  it("every COMMAND_MANIFEST name has a unique entry", () => {
    const names = COMMAND_MANIFEST.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("middleware helpers", () => {
  it("rightsGate denies when canRun is false", async () => {
    const ctx = mockCtx({ canRun: () => false });
    const next = vi.fn(async () => "ok");
    const out = await rightsGate(
      ctx,
      { name: "stop", args: "", rawArgs: [], flags: new Set() },
      emptyDecision,
      next,
    );
    expect(out).toMatch(/permission/i);
    expect(next).not.toHaveBeenCalled();
  });

  it("audioGuard blocks when disconnected", async () => {
    const ctx = mockCtx({
      bot: { isConnected: () => false } as any,
    });
    const next = vi.fn(async () => "ok");
    const out = await audioGuard(
      ctx,
      { name: "skip", args: "", rawArgs: [], flags: new Set() },
      emptyDecision,
      next,
    );
    expect(out).toMatch(/not connected/i);
    expect(next).not.toHaveBeenCalled();
  });

  it("composeMiddleware chains left-to-right", async () => {
    const order: string[] = [];
    const mw = composeMiddleware(
      async (_c, _cmd, _d, next) => {
        order.push("1");
        return next();
      },
      async (_c, _cmd, _d, next) => {
        order.push("2");
        return next();
      },
    );
    await mw(mockCtx(), { name: "x", args: "", rawArgs: [], flags: new Set() }, emptyDecision, async () => {
      order.push("3");
      return "done";
    });
    expect(order).toEqual(["1", "2", "3"]);
  });
});
