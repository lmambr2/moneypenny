import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ControlRouter,
  toolCallToCommand,
  type LlmAssist,
  type RouterContext,
} from "./router.js";

// Minimal logger that satisfies the Logger surface the router touches.
function fakeLogger(): any {
  const l: any = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  l.child = () => l;
  return l;
}

// A fake BotInstance exposing only what the router/handlers use.
function fakeBot(overrides: Partial<any> = {}): any {
  return {
    isConnected: () => true,
    localProvider: undefined,
    ...overrides,
  };
}

function makeContext(bot: any): RouterContext {
  return { bot, logger: fakeLogger() };
}

describe("toolCallToCommand", () => {
  it("maps play_music with auto source to a flagless play command", () => {
    const cmd = toolCallToCommand({ name: "play_music", arguments: { query: "bohemian rhapsody" } });
    expect(cmd).not.toBeNull();
    expect(cmd!.name).toBe("play");
    expect(cmd!.args).toBe("bohemian rhapsody");
    expect(cmd!.flags.size).toBe(0);
  });

  it("maps play_music source preferences to provider flags", () => {
    expect(toolCallToCommand({ name: "play_music", arguments: { query: "x", source: "youtube" } })!.flags.has("y")).toBe(true);
    expect(toolCallToCommand({ name: "play_music", arguments: { query: "x", source: "local" } })!.flags.has("l")).toBe(true);
  });

  it("maps queue() to add", () => {
    const cmd = toolCallToCommand({ name: "queue", arguments: { query: "jazz" } });
    expect(cmd!.name).toBe("add");
    expect(cmd!.args).toBe("jazz");
  });

  it("maps set_volume to vol with a rounded integer arg", () => {
    const cmd = toolCallToCommand({ name: "set_volume", arguments: { level: 42.6 } });
    expect(cmd!.name).toBe("vol");
    expect(cmd!.args).toBe("43");
  });

  it("maps transport tools", () => {
    expect(toolCallToCommand({ name: "skip", arguments: {} })!.name).toBe("skip");
    expect(toolCallToCommand({ name: "pause", arguments: {} })!.name).toBe("pause");
    expect(toolCallToCommand({ name: "resume", arguments: {} })!.name).toBe("resume");
    expect(toolCallToCommand({ name: "stop", arguments: {} })!.name).toBe("stop");
    expect(toolCallToCommand({ name: "now_playing", arguments: {} })!.name).toBe("now");
  });

  it("returns null for unknown tools and empty queries", () => {
    expect(toolCallToCommand({ name: "frobnicate", arguments: {} })).toBeNull();
    expect(toolCallToCommand({ name: "play_music", arguments: { query: "  " } })).toBeNull();
    expect(toolCallToCommand({ name: "set_volume", arguments: { level: "loud" } })).toBeNull();
  });
});

describe("ControlRouter — deterministic routing", () => {
  let router: ControlRouter;

  beforeEach(() => {
    router = new ControlRouter(fakeLogger());
  });

  it("ignores non-prefixed chat (no spam)", async () => {
    const d = await router.route("just chatting", makeContext(fakeBot()), "!");
    expect(d.type).toBe("unknown");
  });

  it("routes a known command deterministically", async () => {
    const d = await router.route("!skip", makeContext(fakeBot()), "!");
    expect(d.type).toBe("deterministic");
    expect(d.command!.name).toBe("skip");
  });

  it("resolves aliases when deciding known vs fuzzy", async () => {
    const d = await router.route("!s", makeContext(fakeBot()), "!", { s: "skip" });
    expect(d.type).toBe("deterministic");
    expect(d.command!.name).toBe("skip");
  });

  it("pre-resolves local music via LocalProvider.resolve for play", async () => {
    const resolve = vi.fn().mockResolvedValue({ type: "song", item: { id: "1", name: "Song" } });
    const bot = fakeBot({ localProvider: { resolve } });
    const d = await router.route("!play something", makeContext(bot), "!");
    expect(resolve).toHaveBeenCalledWith("something");
    expect(d.resolvedMusic).toEqual({ type: "song", item: { id: "1", name: "Song" }, providerPlatform: "local" });
  });
});

describe("ControlRouter — LLM routing", () => {
  it("routes !ask to the LLM ask path", async () => {
    const llm: LlmAssist = {
      ask: vi.fn().mockResolvedValue("42"),
      chatForIntent: vi.fn(),
    };
    const router = new ControlRouter(fakeLogger(), llm);
    const d = await router.route("!ask what is the meaning of life", makeContext(fakeBot()), "!");
    expect(d).toEqual({ type: "llm", llmIntent: { mode: "ask", text: "what is the meaning of life" } });

    const out = await router.execute(d, makeContext(fakeBot()));
    expect(llm.ask).toHaveBeenCalledWith("what is the meaning of life", undefined);
    expect(out).toBe("42");
  });

  it("routes unrecognized prefixed input to fuzzy intent (prefix stripped)", async () => {
    const router = new ControlRouter(fakeLogger(), { ask: vi.fn(), chatForIntent: vi.fn() });
    const d = await router.route("!I want some chill jazz", makeContext(fakeBot()), "!");
    expect(d.type).toBe("llm");
    expect(d.llmIntent).toEqual({ mode: "intent", text: "I want some chill jazz" });
  });

  it("executes LLM tool calls through the deterministic handler path", async () => {
    const skip = vi.fn().mockResolvedValue(undefined);
    const bot = fakeBot({ skipNext: skip });
    const llm: LlmAssist = {
      ask: vi.fn(),
      chatForIntent: vi.fn().mockResolvedValue({
        content: null,
        toolCalls: [{ name: "skip", arguments: {} }],
      }),
    };
    const router = new ControlRouter(fakeLogger(), llm);
    // Register the same skip handler BotInstance registers.
    router.registerHandler({ name: "skip", execute: async () => { await bot.skipNext(); return "Skipped to next."; } });

    const d = await router.route("!gimme the next track", makeContext(bot), "!");
    expect(d.type).toBe("llm");
    const out = await router.execute(d, makeContext(bot));
    expect(skip).toHaveBeenCalled();
    expect(out).toBe("Skipped to next.");
  });

  it("returns the model's plain answer when no tool calls are emitted", async () => {
    const llm: LlmAssist = {
      ask: vi.fn(),
      chatForIntent: vi.fn().mockResolvedValue({ content: "I can only help with music." }),
    };
    const router = new ControlRouter(fakeLogger(), llm);
    const d = await router.route("!tell me a joke", makeContext(fakeBot()), "!");
    const out = await router.execute(d, makeContext(fakeBot()));
    expect(out).toBe("I can only help with music.");
  });

  it("LLM tool calls still respect the audio-connection guard", async () => {
    const bot = fakeBot({ isConnected: () => false });
    const llm: LlmAssist = {
      ask: vi.fn(),
      chatForIntent: vi.fn().mockResolvedValue({
        content: null,
        toolCalls: [{ name: "play_music", arguments: { query: "anything" } }],
      }),
    };
    const router = new ControlRouter(fakeLogger(), llm);
    router.registerHandler({ name: "play", execute: async () => "should not reach here" });

    // A fuzzy phrase (not the known `play` command) → LLM emits play_music →
    // the deterministic audio guard must still block it while disconnected.
    const fuzzy = await router.route("!gimme a tune", makeContext(bot), "!");
    const out = await router.execute(fuzzy, makeContext(bot));
    expect(out).toBe("Bot is not connected to TeamSpeak");
  });

  it("threads context.conversationId into ask and chatForIntent", async () => {
    const llm: LlmAssist = {
      ask: vi.fn().mockResolvedValue("ok"),
      chatForIntent: vi.fn().mockResolvedValue({ content: "ok" }),
    };
    const router = new ControlRouter(fakeLogger(), llm);
    const ctx: RouterContext = { bot: fakeBot(), logger: fakeLogger(), conversationId: "room-7" };

    const askDecision = await router.route("!ask hi", ctx, "!");
    await router.execute(askDecision, ctx);
    expect(llm.ask).toHaveBeenCalledWith("hi", "room-7");

    const intentDecision = await router.route("!some vibe", ctx, "!");
    await router.execute(intentDecision, ctx);
    expect(llm.chatForIntent).toHaveBeenCalledWith("some vibe", "room-7");
  });

  it("reports not-configured for !ask when no LLM is wired", async () => {
    const router = new ControlRouter(fakeLogger());
    const d = await router.route("!ask hello", makeContext(fakeBot()), "!");
    const out = await router.execute(d, makeContext(fakeBot()));
    expect(out).toMatch(/not configured/i);
  });
});

describe("ControlRouter — voice routing", () => {
  it("dispatches a prefix-less known command deterministically", async () => {
    const router = new ControlRouter(fakeLogger());
    const d = await router.routeVoice("skip", makeContext(fakeBot()));
    expect(d.type).toBe("deterministic");
    expect(d.command!.name).toBe("skip");
  });

  it("resolves aliases in voice too", async () => {
    const router = new ControlRouter(fakeLogger());
    const d = await router.routeVoice("s", makeContext(fakeBot()), { s: "skip" });
    expect(d.command!.name).toBe("skip");
  });

  it("parses args from a spoken command", async () => {
    const resolve = vi.fn().mockResolvedValue(null);
    const bot = fakeBot({ localProvider: { resolve } });
    const router = new ControlRouter(fakeLogger());
    const d = await router.routeVoice("play bohemian rhapsody", makeContext(bot));
    expect(d.command!.name).toBe("play");
    expect(d.command!.args).toBe("bohemian rhapsody");
    expect(resolve).toHaveBeenCalledWith("bohemian rhapsody");
  });

  it("routes unknown speech to the LLM intent path (covers fuzzy music + Q&A)", async () => {
    const router = new ControlRouter(fakeLogger(), { ask: vi.fn(), chatForIntent: vi.fn() });
    const d = await router.routeVoice("what is the capital of france", makeContext(fakeBot()));
    expect(d.type).toBe("llm");
    expect(d.llmIntent).toEqual({ mode: "intent", text: "what is the capital of france" });
  });

  it("returns unknown for empty transcripts", async () => {
    const router = new ControlRouter(fakeLogger());
    expect((await router.routeVoice("   ", makeContext(fakeBot()))).type).toBe("unknown");
  });
});

describe("ControlRouter — rank gating", () => {
  function ctxWithRights(bot: any, allowed: Set<string>): RouterContext {
    return { bot, logger: fakeLogger(), canRun: (cmd) => allowed.has(cmd) };
  }

  it("denies a typed command the invoker lacks permission for", async () => {
    const skip = vi.fn();
    const router = new ControlRouter(fakeLogger());
    router.registerHandler({ name: "stop", execute: async () => { skip(); return "stopped"; } });

    const ctx = ctxWithRights(fakeBot(), new Set(["play"])); // no "stop"
    const d = await router.route("!stop", ctx, "!");
    const out = await router.execute(d, ctx);
    expect(out).toMatch(/permission/i);
    expect(skip).not.toHaveBeenCalled();
  });

  it("allows a permitted command through", async () => {
    const router = new ControlRouter(fakeLogger());
    router.registerHandler({ name: "stop", execute: async () => "stopped" });
    const ctx = ctxWithRights(fakeBot(), new Set(["stop"]));
    const d = await router.route("!stop", ctx, "!");
    expect(await router.execute(d, ctx)).toBe("stopped");
  });

  it("gates LLM-tool-derived commands identically (no escalation via natural language)", async () => {
    const stopHandler = vi.fn();
    const llm: LlmAssist = {
      ask: vi.fn(),
      chatForIntent: vi.fn().mockResolvedValue({ content: null, toolCalls: [{ name: "stop", arguments: {} }] }),
    };
    const router = new ControlRouter(fakeLogger(), llm);
    router.registerHandler({ name: "stop", execute: async () => { stopHandler(); return "stopped"; } });

    const ctx = ctxWithRights(fakeBot(), new Set(["play"])); // not allowed to stop
    const d = await router.route("!shut it all down", ctx, "!");
    const out = await router.execute(d, ctx);
    expect(stopHandler).not.toHaveBeenCalled();
    expect(out).toMatch(/permission/i);
  });

  it("gates !ask itself", async () => {
    const llm: LlmAssist = { ask: vi.fn().mockResolvedValue("hi"), chatForIntent: vi.fn() };
    const router = new ControlRouter(fakeLogger(), llm);
    const ctx = ctxWithRights(fakeBot(), new Set(["play"])); // no "ask"
    const d = await router.route("!ask anything", ctx, "!");
    const out = await router.execute(d, ctx);
    expect(out).toMatch(/permission/i);
    expect(llm.ask).not.toHaveBeenCalled();
  });
});
