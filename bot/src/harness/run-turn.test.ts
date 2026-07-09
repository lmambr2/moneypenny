import { describe, expect, it, vi } from "vitest";
import { runHarnessTurn } from "./run-turn.js";
import { InMemoryHarnessStore } from "./store.js";

describe("runHarnessTurn (H1/H2/H5)", () => {
  it("returns reply + sources with classification from real retrieve path", async () => {
    const store = new InMemoryHarnessStore();
    const retrieve = vi.fn(async () => [
      {
        text: "Dock at port A",
        source: "combat-doctrine.md",
        score: 0.91,
        classification: "restricted",
      },
    ]);
    const ask = vi.fn(async (q: string) => `About ${q}: dock at port A.\n\n📎 Sources: combat-doctrine.md`);

    const turn = await runHarnessTurn("where do we dock", "ask", {
      llm: { ask },
      retrieve,
      store,
      idFactory: () => "t1",
      now: () => 1000,
    });

    expect(retrieve).toHaveBeenCalledWith("where do we dock");
    expect(ask).toHaveBeenCalled();
    expect(turn.reply).toMatch(/dock at port A/i);
    expect(turn.sources).toEqual([
      {
        text: "Dock at port A",
        source: "combat-doctrine.md",
        score: 0.91,
        classification: "restricted",
      },
    ]);
    expect(turn.error).toBeUndefined();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].id).toBe("t1");
  });

  it("records tool invocations with ok/fail in intent mode", async () => {
    const chatForIntent = vi.fn(async () => ({
      content: "Playing something chill.",
      toolCalls: [
        { name: "play_music", arguments: { query: "ambient" } },
        { name: "now_playing", arguments: {} },
      ],
    }));
    const executeTool = vi.fn(async (name: string) => {
      if (name === "play_music") return { ok: true, result: "Queued ambient" };
      return { ok: false, error: "player offline" };
    });

    const turn = await runHarnessTurn("play ambient", "intent", {
      llm: { ask: async () => "", chatForIntent },
      executeTool,
      idFactory: () => "t2",
      now: () => 2000,
    });

    expect(turn.tools).toHaveLength(2);
    expect(turn.tools[0]).toMatchObject({
      name: "play_music",
      args: { query: "ambient" },
      ok: true,
      result: "Queued ambient",
    });
    expect(turn.tools[1]).toMatchObject({
      name: "now_playing",
      ok: false,
      error: "player offline",
    });
    expect(turn.reply).toMatch(/Playing something chill/i);
    expect(turn.reply).toMatch(/Queued ambient/);
  });

  it("surfaces LLM-down as turn error not silent empty", async () => {
    const turn = await runHarnessTurn("hello", "ask", {
      llm: {
        ask: async () => {
          throw new Error("connection refused");
        },
      },
      idFactory: () => "t3",
      now: () => 3000,
    });
    expect(turn.error).toMatch(/connection refused/i);
    expect(turn.reply).toBe("");
  });

  it("surfaces RAG failure as turn error", async () => {
    const turn = await runHarnessTurn("q", "ask", {
      llm: { ask: async () => "should not run" },
      retrieve: async () => {
        throw new Error("qdrant down");
      },
      idFactory: () => "t4",
      now: () => 4000,
    });
    expect(turn.error).toMatch(/qdrant down/i);
    expect(turn.reply).toBe("");
  });

  it("errors when LLM disabled", async () => {
    const turn = await runHarnessTurn("q", "ask", {
      llm: null,
      idFactory: () => "t5",
      now: () => 5000,
    });
    expect(turn.error).toMatch(/not enabled/i);
  });
});
