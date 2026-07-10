import { describe, expect, it } from "vitest";
import {
  assembleTurnContext,
  capWorkingTurns,
  injectionKey,
  selectWithDedup,
} from "./turn-context.js";

describe("selectWithDedup", () => {
  it("picks highest scores within budget", () => {
    const log = new Set<string>();
    const out = selectWithDedup(
      [
        { id: "a", type: "doctrine", text: "a", score: 0.5 },
        { id: "b", type: "doctrine", text: "b", score: 0.9 },
        { id: "c", type: "doctrine", text: "c", score: 0.7 },
      ],
      log,
      2,
    );
    expect(out.map((x) => x.id)).toEqual(["b", "c"]);
    expect(log.has(injectionKey("doctrine", "b"))).toBe(true);
  });

  it("skips already injected ids", () => {
    const log = new Set<string>([injectionKey("doctrine", "b")]);
    const out = selectWithDedup(
      [
        { id: "a", type: "doctrine", text: "a", score: 0.5 },
        { id: "b", type: "doctrine", text: "b", score: 0.9 },
      ],
      log,
      2,
    );
    expect(out.map((x) => x.id)).toEqual(["a"]);
  });
});

describe("assembleTurnContext", () => {
  it("builds system blocks and dedups across calls", () => {
    const log = new Set<string>();
    const first = assembleTurnContext({
      doctrine: [
        { id: "d1", type: "doctrine", text: "Dock at A", score: 1, source: "ops.md" },
        { id: "d2", type: "doctrine", text: "Dock at B", score: 0.5, source: "ops.md" },
      ],
      budgets: { doctrineChunks: 2 },
      injectionLog: log,
    });
    expect(first.systemBlocks.length).toBe(1);
    expect(first.selected).toHaveLength(2);

    const second = assembleTurnContext({
      doctrine: [
        { id: "d1", type: "doctrine", text: "Dock at A", score: 1, source: "ops.md" },
        { id: "d3", type: "doctrine", text: "New fact", score: 0.8, source: "ops.md" },
      ],
      budgets: { doctrineChunks: 2 },
      injectionLog: log,
    });
    expect(second.selected.map((s) => s.id)).toEqual(["d3"]);
    expect(second.skippedDedup).toBeGreaterThanOrEqual(1);
  });
});

describe("capWorkingTurns", () => {
  it("keeps the last N turns (2N messages)", () => {
    const msgs = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(capWorkingTurns(msgs, 2)).toEqual([5, 6, 7, 8]);
    expect(capWorkingTurns(msgs, 10)).toEqual(msgs);
  });
});
