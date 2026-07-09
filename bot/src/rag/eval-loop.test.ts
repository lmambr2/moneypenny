import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EVAL_CASES, runEvalCase, runEvalLoop } from "./eval-loop.js";

describe("RAG eval loop (R3)", () => {
  it("passes doctrine case when retrieval returns hits", async () => {
    const r = await runEvalCase(
      { id: "d1", query: "ops", expect: "doctrine" },
      {
        queryDoctrine: async () => [
          { text: "Ops brief at 1900", source: "ops.md", classification: "unclassified" },
        ],
      },
    );
    expect(r.pass).toBe(true);
    expect(r.doctrineHits).toBe(1);
  });

  it("fails doctrine case on empty corpus", async () => {
    const r = await runEvalCase(
      { id: "d2", query: "ops", expect: "doctrine" },
      { queryDoctrine: async () => [] },
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/doctrine hits/);
  });

  it("fails when doctrine text is empty (empty rewrite risk)", async () => {
    const r = await runEvalCase(
      { id: "d3", query: "x", expect: "doctrine" },
      { queryDoctrine: async () => [{ text: "   ", source: "a.md" }] },
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/empty/i);
  });

  it("org_memory case uses org search only", async () => {
    const queryDoctrine = vi.fn(async () => [
      { text: "should not satisfy org case", source: "d.md" },
    ]);
    const r = await runEvalCase(
      { id: "o1", query: "FC", expect: "org_memory" },
      {
        queryDoctrine,
        queryOrgMemory: async () => [{ fact: "FC is Alice" }],
      },
    );
    expect(r.pass).toBe(true);
    expect(r.orgHits).toBe(1);
  });

  it("either passes with org only", async () => {
    const r = await runEvalCase(
      { id: "e1", query: "welcome", expect: "either" },
      { queryOrgMemory: async () => [{ fact: "welcome to station" }] },
    );
    expect(r.pass).toBe(true);
  });

  it("full loop reports ok when all fixtures pass", async () => {
    const report = await runEvalLoop(DEFAULT_EVAL_CASES, {
      queryDoctrine: async (q) =>
        q.includes("combat") || q.includes("ops") || q.includes("station")
          ? [{ text: `hit for ${q}`, source: "doc.md", score: 0.9 }]
          : [],
      queryOrgMemory: async (q) =>
        q.includes("fleet") || q.includes("station")
          ? [{ fact: `org fact ${q}` }]
          : [],
    });
    expect(report.ok).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(DEFAULT_EVAL_CASES.length);
  });
});
