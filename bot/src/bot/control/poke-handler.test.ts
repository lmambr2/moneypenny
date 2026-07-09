import { describe, it, expect, vi } from "vitest";
import { PokeHandler, PokeRateLimiter, shouldMirrorToChannel } from "./poke-handler.js";

describe("PokeRateLimiter", () => {
  it("allows up to max per window then denies", () => {
    const lim = new PokeRateLimiter(60_000);
    const t0 = 1_000_000;
    expect(lim.allow("u1", 2, t0)).toBe(true);
    expect(lim.allow("u1", 2, t0 + 1)).toBe(true);
    expect(lim.allow("u1", 2, t0 + 2)).toBe(false);
    expect(lim.allow("u2", 2, t0 + 2)).toBe(true);
  });

  it("expires old hits", () => {
    const lim = new PokeRateLimiter(1000);
    expect(lim.allow("u1", 1, 1000)).toBe(true);
    expect(lim.allow("u1", 1, 1500)).toBe(false);
    expect(lim.allow("u1", 1, 2100)).toBe(true);
  });
});

describe("shouldMirrorToChannel", () => {
  it("mirrors now playing and long replies", () => {
    expect(shouldMirrorToChannel("Now playing: Foo")).toBe(true);
    expect(shouldMirrorToChannel("Skipped to next.")).toBe(true);
    expect(shouldMirrorToChannel("ok")).toBe(false);
    expect(shouldMirrorToChannel("x".repeat(120))).toBe(true);
  });
});

describe("PokeHandler", () => {
  it("routes a poke command and poke-replies", async () => {
    const pokeClient = vi.fn();
    const sendTextMessage = vi.fn();
    const routeVoice = vi.fn().mockResolvedValue({
      type: "deterministic",
      command: { name: "skip" },
    });
    const execute = vi.fn().mockResolvedValue("Skipped to next.");
    const handler = new PokeHandler({
      bot: {} as any,
      config: {
        pokeCommandsEnabled: true,
        pokeCommandsPerMinute: 12,
        commandAliases: {},
      } as any,
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      tsClient: { pokeClient, sendTextMessage } as any,
      router: { routeVoice, execute } as any,
      llm: { classificationsFor: vi.fn() } as any,
      rightsEngine: () => null,
    });

    await handler.handle({
      invokerName: "Alice",
      invokerId: "42",
      invokerUid: "uid-a",
      message: "skip",
    });

    expect(routeVoice).toHaveBeenCalledWith(
      "skip",
      expect.objectContaining({ invokerUid: "uid-a" }),
      {},
    );
    expect(execute).toHaveBeenCalled();
    expect(pokeClient).toHaveBeenCalledWith(42, "Skipped to next.");
    expect(sendTextMessage).toHaveBeenCalledWith("Skipped to next.");
  });

  it("ignores when pokeCommandsEnabled is false", async () => {
    const routeVoice = vi.fn();
    const handler = new PokeHandler({
      bot: {} as any,
      config: { pokeCommandsEnabled: false, pokeCommandsPerMinute: 12 } as any,
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      tsClient: { pokeClient: vi.fn(), sendTextMessage: vi.fn() } as any,
      router: { routeVoice, execute: vi.fn() } as any,
      llm: { classificationsFor: vi.fn() } as any,
      rightsEngine: () => null,
    });
    await handler.handle({
      invokerName: "Alice",
      invokerId: "1",
      invokerUid: "u",
      message: "skip",
    });
    expect(routeVoice).not.toHaveBeenCalled();
  });

  it("rate-limits abusive pokers", async () => {
    const pokeClient = vi.fn();
    const routeVoice = vi.fn().mockResolvedValue({ type: "unknown" });
    const handler = new PokeHandler({
      bot: {} as any,
      config: {
        pokeCommandsEnabled: true,
        pokeCommandsPerMinute: 1,
        commandAliases: {},
      } as any,
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      tsClient: { pokeClient, sendTextMessage: vi.fn() } as any,
      router: { routeVoice, execute: vi.fn() } as any,
      llm: { classificationsFor: vi.fn() } as any,
      rightsEngine: () => null,
    });
    await handler.handle({
      invokerName: "A",
      invokerId: "9",
      invokerUid: "spam",
      message: "skip",
    });
    await handler.handle({
      invokerName: "A",
      invokerId: "9",
      invokerUid: "spam",
      message: "skip",
    });
    expect(routeVoice).toHaveBeenCalledTimes(1);
    expect(pokeClient).toHaveBeenCalledWith(9, "Too many pokes — slow down.");
  });
});
