import { describe, expect, it, vi } from "vitest";
import { completeTurn } from "./complete-turn.js";
import { disposeToolProposals } from "./dispose.js";
import { createHttpBrain } from "./http-brain.js";
import { createInProcessBrain } from "./in-process.js";
import { resolveBrainTransport } from "./factory.js";
import { BrainUnavailableError } from "./types.js";

describe("InProcessBrain", () => {
  it("ask mode returns reply + sources without tools", async () => {
    const brain = createInProcessBrain({
      llm: { ask: async (q) => `Answer: ${q}` },
      retrieve: async () => [
        { source: "doc.md", text: "snippet", classification: "unclassified", score: 0.9 },
      ],
      idFactory: () => "t1",
    });
    const r = await brain.completeTurn({
      channel: "dashboard",
      text: "hello",
      mode: "ask",
    });
    expect(r.replyText).toBe("Answer: hello");
    expect(r.sources).toHaveLength(1);
    expect(r.toolProposals).toEqual([]);
    expect(r.error).toBeNull();
  });

  it("intent mode proposes tools but does not execute them", async () => {
    const brain = createInProcessBrain({
      llm: {
        ask: async () => "",
        chatForIntent: async () => ({
          content: "Sure",
          toolCalls: [{ name: "play_music", arguments: { query: "ambient" } }],
        }),
      },
      idFactory: () => "t2",
    });
    const r = await brain.completeTurn({
      channel: "dashboard",
      text: "play ambient",
      mode: "intent",
    });
    expect(r.toolProposals).toEqual([
      { name: "play_music", arguments: { query: "ambient" } },
    ]);
    expect(r.replyText).toBe("Sure");
  });

  it("errors when LLM disabled", async () => {
    const brain = createInProcessBrain({ llm: null, idFactory: () => "t3" });
    const r = await brain.completeTurn({ channel: "dashboard", text: "x" });
    expect(r.error).toMatch(/not enabled/i);
  });
});

describe("disposeToolProposals", () => {
  it("maps ok/fail without throwing", async () => {
    const exec = vi.fn(async (name: string) => {
      if (name === "bad") throw new Error("boom");
      return { ok: true, result: "ok" };
    });
    const out = await disposeToolProposals(
      [
        { name: "good", arguments: {} },
        { name: "bad", arguments: { a: 1 } },
      ],
      exec,
    );
    expect(out[0]).toMatchObject({ name: "good", ok: true, result: "ok" });
    expect(out[1]).toMatchObject({ name: "bad", ok: false, error: "boom" });
  });
});

describe("HttpBrain", () => {
  it("posts to /v1/turn and normalizes result", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          turnId: "remote-1",
          replyText: "hi",
          sources: [],
          toolProposals: [{ name: "skip", arguments: {} }],
          error: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const brain = createHttpBrain({
      baseUrl: "http://brain.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await brain.completeTurn({ channel: "dashboard", text: "hey" });
    expect(fetchImpl).toHaveBeenCalled();
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("http://brain.example/v1/turn");
    expect(call[1].method).toBe("POST");
    expect(r.turnId).toBe("remote-1");
    expect(r.toolProposals[0].name).toBe("skip");
  });

  it("throws BrainUnavailableError on 503", async () => {
    const brain = createHttpBrain({
      baseUrl: "http://brain.example",
      fetchImpl: (async () => new Response("down", { status: 503 })) as typeof fetch,
    });
    await expect(brain.completeTurn({ channel: "dashboard", text: "x" })).rejects.toBeInstanceOf(
      BrainUnavailableError,
    );
  });
});

describe("completeTurn softFail", () => {
  it("maps BrainUnavailableError to soft result", async () => {
    const transport = {
      completeTurn: async () => {
        throw new BrainUnavailableError("Brain unavailable (503)", 503);
      },
    };
    const r = await completeTurn({ channel: "dashboard", text: "x" }, transport);
    expect(r.error).toMatch(/unavailable/i);
    expect(r.toolProposals).toEqual([]);
  });
});

describe("resolveBrainTransport", () => {
  it("uses in-process when brainUrl empty", async () => {
    const t = resolveBrainTransport({
      brainUrl: "",
      inProcess: {
        llm: { ask: async () => "local" },
        idFactory: () => "x",
      },
    });
    const r = await t.completeTurn({ channel: "dashboard", text: "q" });
    expect(r.replyText).toBe("local");
  });

  it("uses http when brainUrl set", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            turnId: "r",
            replyText: "remote",
            sources: [],
            toolProposals: [],
            error: null,
          }),
          { status: 200 },
        ),
    );
    const t = resolveBrainTransport({
      brainUrl: "http://remote",
      inProcess: { llm: null },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await t.completeTurn({ channel: "dashboard", text: "q" });
    expect(r.replyText).toBe("remote");
    expect(fetchImpl).toHaveBeenCalled();
  });
});
