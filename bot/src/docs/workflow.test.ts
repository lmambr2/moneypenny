import { describe, it, expect } from "vitest";
import {
  buildWorkflowTask,
  parseWorkflowCommand,
  workflowSavePath,
  WORKFLOW_USAGE,
} from "./workflow.js";

describe("parseWorkflowCommand", () => {
  it("requires bullet content", () => {
    expect(parseWorkflowCommand("intsum", { args: "", flags: new Set() })).toEqual({
      error: WORKFLOW_USAGE.intsum,
    });
  });

  it("splits semicolon bullets and parses class: + -s flag", () => {
    const out = parseWorkflowCommand("intsum", {
      args: "class:secret north flank quiet; comms degraded",
      flags: new Set(["s"]),
    });
    expect(out).toMatchObject({
      kind: "intsum",
      bullets: ["north flank quiet", "comms degraded"],
      classification: "secret",
      save: true,
    });
  });

  it("splits pipe bullets for AAR", () => {
    const out = parseWorkflowCommand("aar", {
      args: "objective met | RTB on time",
      flags: new Set(),
    });
    expect(out).toMatchObject({
      kind: "aar",
      bullets: ["objective met", "RTB on time"],
      classification: "unclassified",
      save: false,
    });
  });
});

describe("buildWorkflowTask", () => {
  it("embeds skeleton and operator bullets", () => {
    const task = buildWorkflowTask({
      kind: "intsum",
      bullets: ["alpha secure"],
      classification: "restricted",
      save: false,
    });
    expect(task).toContain("INTSUM");
    expect(task).toContain("1. alpha secure");
    expect(task).toContain("classification: restricted");
  });
});

describe("workflowSavePath", () => {
  it("namespaced by kind and date", () => {
    expect(workflowSavePath("intsum", new Date("2026-06-21T12:00:00Z"))).toBe("intel/intsum-2026-06-21.md");
    expect(workflowSavePath("aar", new Date("2026-06-21T12:00:00Z"))).toBe("reports/aar-2026-06-21.md");
  });
});