import { describe, it, expect, beforeEach, vi } from "vitest";
import type { BotInstance } from "../bot/instance.js";
import type { Logger } from "../logger.js";
import {
  ControlRouter,
  toolCallToCommand,
  type LlmAssist,
  type RouterContext,
} from "./router.js";
import { registerBotCommandHandlers } from "./register-handlers.js";

type RouterBotStub = Pick<BotInstance, "isConnected" | "resolveLocalMusic"> & Record<string, unknown>;

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

function fakeBot(overrides: Partial<RouterBotStub> = {}): BotInstance {
  return {
    isConnected: () => true,
    resolveLocalMusic: async () => null,
    ...overrides,
  } as BotInstance;
}

function makeContext(bot: BotInstance): RouterContext {
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

  it("maps select_tracks to selecttracks with JSON filter args", () => {
    const cmd = toolCallToCommand({
      name: "select_tracks",
      arguments: { genreAny: ["ambient"], bpmMax: 110 },
    });
    expect(cmd!.name).toBe("selecttracks");
    expect(JSON.parse(cmd!.args)).toEqual({ genreAny: ["ambient"], bpmMax: 110 });
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

  it("maps move_client to moveclient with channel in rawArgs", () => {
    const cmd = toolCallToCommand({
      name: "move_client",
      arguments: { client: "Bond", channel: "Briefing Room" },
    });
    expect(cmd?.name).toBe("moveclient");
    expect(cmd?.rawArgs).toEqual(["Bond", "Briefing Room"]);
  });

  it("maps move_all_clients to moveall", () => {
    const cmd = toolCallToCommand({ name: "move_all_clients", arguments: { channel: "Lobby" } });
    expect(cmd?.name).toBe("moveall");
    expect(cmd?.args).toBe("Lobby");
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
    const bot = fakeBot({ resolveLocalMusic: resolve });
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
      delegate: vi.fn(),
    };
    const router = new ControlRouter(fakeLogger(), llm);
    const d = await router.route("!ask what is the meaning of life", makeContext(fakeBot()), "!");
    expect(d).toEqual({ type: "llm", llmIntent: { mode: "ask", text: "what is the meaning of life" } });

    const out = await router.execute(d, makeContext(fakeBot()));
    expect(llm.ask).toHaveBeenCalledWith("what is the meaning of life", undefined, {
      allowedClassifications: undefined,
      userUid: undefined,
    });
    expect(out).toBe("42");
  });

  it("routes unrecognized prefixed input to fuzzy intent (prefix stripped)", async () => {
    const router = new ControlRouter(fakeLogger(), { ask: vi.fn(), chatForIntent: vi.fn(), delegate: vi.fn() });
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
      delegate: vi.fn(),
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
      delegate: vi.fn(),
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
      delegate: vi.fn(),
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
      delegate: vi.fn(),
    };
    const router = new ControlRouter(fakeLogger(), llm);
    const ctx: RouterContext = { bot: fakeBot(), logger: fakeLogger(), conversationId: "room-7" };

    const askDecision = await router.route("!ask hi", ctx, "!");
    await router.execute(askDecision, ctx);
    expect(llm.ask).toHaveBeenCalledWith("hi", "room-7", {
      allowedClassifications: undefined,
      userUid: undefined,
    });

    const intentDecision = await router.route("!some vibe", ctx, "!");
    await router.execute(intentDecision, ctx);
    expect(llm.chatForIntent).toHaveBeenCalledWith("some vibe", "room-7", { moveClientEnabled: true });
  });

  it("executes move_client tool calls as moveclient (R4)", async () => {
    const move = vi.fn().mockResolvedValue("Moved Bond → Briefing Room.");
    const bot = {
      isConnected: () => true,
      executeCommand: move,
    };
    const llm: LlmAssist = {
      ask: vi.fn(),
      chatForIntent: vi.fn().mockResolvedValue({
        content: null,
        toolCalls: [{ name: "move_client", arguments: { client: "Bond", channel: "Briefing Room" } }],
      }),
      delegate: vi.fn(),
    };
    const router = new ControlRouter(fakeLogger(), llm);
    registerBotCommandHandlers(router, {
      commands: { execute: move } as any,
      playback: {} as any,
      roast: {} as any,
      memory: {} as any,
      kg: {} as any,
      knowledge: {} as any,
    });

    const d = await router.route("!relocate Bond to Briefing Room", makeContext(bot as any), "!");
    const out = await router.execute(d, makeContext(bot as any));
    expect(move).toHaveBeenCalled();
    const cmd = move.mock.calls[0]![0];
    expect(cmd.name).toBe("moveclient");
    expect(cmd.rawArgs).toEqual(["Bond", "Briefing Room"]);
    expect(out).toBeDefined();
  });

  it("reports not-configured for !ask when no LLM is wired", async () => {
    const router = new ControlRouter(fakeLogger());
    const d = await router.route("!ask hello", makeContext(fakeBot()), "!");
    const out = await router.execute(d, makeContext(fakeBot()));
    expect(out).toMatch(/not configured/i);
  });

  it("routes !analyst to the delegate path (sync when no postFollowUp)", async () => {
    const llm: LlmAssist = {
      ask: vi.fn(),
      chatForIntent: vi.fn(),
      delegate: vi.fn().mockResolvedValue("INTSUM draft"),
      isDelegateConfigured: () => true,
    };
    const router = new ControlRouter(fakeLogger(), llm);
    const d = await router.route("!analyst summarise recruitment doctrine", makeContext(fakeBot()), "!");
    expect(d.type).toBe("llm");
    expect(d.llmIntent).toMatchObject({ mode: "delegate", text: "summarise recruitment doctrine" });
    const out = await router.execute(d, makeContext(fakeBot()));
    expect(llm.delegate).toHaveBeenCalledWith("summarise recruitment doctrine", undefined, {
      allowedClassifications: undefined,
      userUid: undefined,
    });
    expect(out).toContain("INTSUM draft");
  });

  it("!analyst -s saves delegate output to doctrine (sync)", async () => {
    const saveAnalystDoc = vi.fn().mockResolvedValue({ ok: true, source: "reports/analyst-2026-06-22.md" });
    const llm: LlmAssist = {
      ask: vi.fn(),
      chatForIntent: vi.fn(),
      delegate: vi.fn().mockResolvedValue("# Brief\nOps summary."),
      isDelegateConfigured: () => true,
    };
    const router = new ControlRouter(fakeLogger(), llm);
    const d = await router.route("!analyst -s class:secret draft brief", makeContext(fakeBot({ saveAnalystDoc })), "!");
    const out = await router.execute(d, makeContext(fakeBot({ saveAnalystDoc })));
    expect(saveAnalystDoc).toHaveBeenCalledWith("# Brief\nOps summary.", "secret");
    expect(out).toContain("Saved to knowledge base");
  });

  it("acks !analyst immediately and posts the result via postFollowUp (R1b)", async () => {
    const llm: LlmAssist = {
      ask: vi.fn(),
      chatForIntent: vi.fn(),
      delegate: vi.fn().mockImplementation(() => new Promise((r) => setTimeout(() => r("INTSUM draft"), 20))),
      isDelegateConfigured: () => true,
    };
    const router = new ControlRouter(fakeLogger(), llm);
    const d = await router.route("!analyst summarise doctrine", makeContext(fakeBot()), "!");
    const posts: string[] = [];
    const ctx = {
      ...makeContext(fakeBot()),
      invokerName: "Bond",
      postFollowUp: async (text: string) => { posts.push(text); },
    };
    const out = await router.execute(d, ctx);
    expect(out).toMatch(/Analyst on it/i);
    expect(llm.delegate).toHaveBeenCalled();
    expect(posts).toHaveLength(0);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toContain("INTSUM draft");
    expect(posts[0]).toContain("Bond");
  });

  it("executes delegate_to_agent tool calls from fuzzy intent (sync)", async () => {
    const llm: LlmAssist = {
      ask: vi.fn(),
      chatForIntent: vi.fn().mockResolvedValue({
        content: null,
        toolCalls: [{ name: "delegate_to_agent", arguments: { task: "write INTSUM", context: "ops last week" } }],
      }),
      delegate: vi.fn().mockResolvedValue("Done."),
    };
    const router = new ControlRouter(fakeLogger(), llm);
    const d = await router.route("!deep analysis please", makeContext(fakeBot()), "!");
    const out = await router.execute(d, makeContext(fakeBot()));
    expect(llm.delegate).toHaveBeenCalledWith("write INTSUM", "ops last week", expect.any(Object));
    expect(out).toBe("📋 Analyst result:\nDone.");
  });

  it("routes !intsum to workflow generation (sync)", async () => {
    const llm: LlmAssist = {
      ask: vi.fn(),
      chatForIntent: vi.fn(),
      delegate: vi.fn(),
      generateWorkflowDoc: vi.fn().mockResolvedValue("---\n# INTSUM\nbody"),
      isDelegateConfigured: () => true,
    };
    const router = new ControlRouter(fakeLogger(), llm);
    const d = await router.route("!intsum alpha secure; comms ok", makeContext(fakeBot()), "!");
    expect(d).toEqual({
      type: "llm",
      llmIntent: {
        mode: "workflow",
        text: "alpha secure; comms ok",
        workflowKind: "intsum",
        workflowFlags: new Set(),
      },
    });
    const out = await router.execute(d, makeContext(fakeBot()));
    expect(llm.generateWorkflowDoc).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "intsum", bullets: ["alpha secure", "comms ok"] }),
      expect.any(Object),
    );
    expect(out).toContain("INTSUM");
  });

  it("denies !aar when analyst right is missing", async () => {
    const llm: LlmAssist = {
      ask: vi.fn(),
      chatForIntent: vi.fn(),
      delegate: vi.fn(),
      generateWorkflowDoc: vi.fn(),
      isDelegateConfigured: () => true,
    };
    const router = new ControlRouter(fakeLogger(), llm);
    const d = await router.route("!aar objective met", makeContext(fakeBot()), "!");
    const ctx = {
      ...makeContext(fakeBot()),
      canRun: (cmd: string) => cmd !== "aar",
    };
    const out = await router.execute(d, ctx);
    expect(llm.generateWorkflowDoc).not.toHaveBeenCalled();
    expect(out).toMatch(/permission/i);
  });

  it("denies delegate_to_agent when analyst right is missing", async () => {
    const llm: LlmAssist = {
      ask: vi.fn(),
      chatForIntent: vi.fn().mockResolvedValue({
        content: null,
        toolCalls: [{ name: "delegate_to_agent", arguments: { task: "write INTSUM" } }],
      }),
      delegate: vi.fn(),
    };
    const router = new ControlRouter(fakeLogger(), llm);
    const d = await router.route("!deep analysis please", makeContext(fakeBot()), "!");
    const ctx = {
      ...makeContext(fakeBot()),
      canRun: (cmd: string) => cmd !== "analyst",
    };
    const out = await router.execute(d, ctx);
    expect(llm.delegate).not.toHaveBeenCalled();
    expect(out).toMatch(/permission/i);
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
    const bot = fakeBot({ resolveLocalMusic: resolve });
    const router = new ControlRouter(fakeLogger());
    const d = await router.routeVoice("play bohemian rhapsody", makeContext(bot));
    expect(d.command!.name).toBe("play");
    expect(d.command!.args).toBe("bohemian rhapsody");
    expect(resolve).toHaveBeenCalledWith("bohemian rhapsody");
  });

  it("routes unknown speech to the LLM intent path (covers fuzzy music + Q&A)", async () => {
    const router = new ControlRouter(fakeLogger(), { ask: vi.fn(), chatForIntent: vi.fn(), delegate: vi.fn() });
    const d = await router.routeVoice("what is the capital of france", makeContext(fakeBot()));
    expect(d.type).toBe("llm");
    expect(d.llmIntent).toEqual({ mode: "intent", text: "what is the capital of france" });
  });

  it("returns unknown for empty transcripts", async () => {
    const router = new ControlRouter(fakeLogger());
    expect((await router.routeVoice("   ", makeContext(fakeBot()))).type).toBe("unknown");
  });

  it("strips trailing STT punctuation before command matching", async () => {
    const router = new ControlRouter(fakeLogger());
    const d = await router.routeVoice("Pause.", makeContext(fakeBot()));
    expect(d.type).toBe("deterministic");
    expect(d.command!.name).toBe("pause");
  });
});

describe("ControlRouter — rank gating", () => {
  function ctxWithRights(bot: BotInstance, allowed: Set<string>): RouterContext {
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
      delegate: vi.fn(),
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
    const llm: LlmAssist = { ask: vi.fn().mockResolvedValue("hi"), chatForIntent: vi.fn(), delegate: vi.fn() };
    const router = new ControlRouter(fakeLogger(), llm);
    const ctx = ctxWithRights(fakeBot(), new Set(["play"])); // no "ask"
    const d = await router.route("!ask anything", ctx, "!");
    const out = await router.execute(d, ctx);
    expect(out).toMatch(/permission/i);
    expect(llm.ask).not.toHaveBeenCalled();
  });
});

describe("ControlRouter — radio.power gating", () => {
  it("denies !radio on without the radio.power token", async () => {
    const router = new ControlRouter(fakeLogger());
    const handler = vi.fn(async () => "toggled");
    router.registerHandler({ name: "radio", execute: handler });
    const d = await router.route("!radio on", makeContext(fakeBot()), "!");
    const out = await router.execute(d, {
      ...makeContext(fakeBot()),
      canRun: (c: string) => c !== "radio.power",
    });
    expect(out).toMatch(/permission/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies !radio ops <profile> without radio.ops, but ops list stays public", async () => {
    const router = new ControlRouter(fakeLogger());
    const handler = vi.fn(async () => "ok");
    router.registerHandler({ name: "radio", execute: handler });
    const canRun = (c: string) => c !== "radio.ops";

    const setOps = await router.route("!radio ops mining", makeContext(fakeBot()), "!");
    expect(await router.execute(setOps, { ...makeContext(fakeBot()), canRun })).toMatch(/permission/i);
    expect(handler).not.toHaveBeenCalled();

    const list = await router.route("!radio ops list", makeContext(fakeBot()), "!");
    expect(await router.execute(list, { ...makeContext(fakeBot()), canRun })).toBe("ok");
  });

  it.each([
    ["bumper", "radio.bumper"],
    ["say hello there", "radio.say"],
    ["skip", "radio.skip"],
  ])("denies !radio %s without %s", async (subArgs, token) => {
    const router = new ControlRouter(fakeLogger());
    const handler = vi.fn(async () => "ok");
    router.registerHandler({ name: "radio", execute: handler });
    const d = await router.route(`!radio ${subArgs}`, makeContext(fakeBot()), "!");
    const out = await router.execute(d, {
      ...makeContext(fakeBot()),
      canRun: (c: string) => c !== token,
    });
    expect(out).toMatch(/permission/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows !radio status without radio.power (status is public)", async () => {
    const router = new ControlRouter(fakeLogger());
    const handler = vi.fn(async () => "status ok");
    router.registerHandler({ name: "radio", execute: handler });
    const d = await router.route("!radio", makeContext(fakeBot()), "!");
    const out = await router.execute(d, {
      ...makeContext(fakeBot()),
      canRun: (c: string) => c !== "radio.power",
    });
    expect(out).toBe("status ok");
    expect(handler).toHaveBeenCalled();
  });
});
