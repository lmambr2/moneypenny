import type { ParsedCommand } from "../bot/commands.js";

/** DESIGN §R3 — templated org docs routed to the delegate model. */
export type WorkflowKind = "intsum" | "aar";

export interface WorkflowRequest {
  kind: WorkflowKind;
  bullets: string[];
  /** Frontmatter classification when saving to doctrine. */
  classification: string;
  save: boolean;
}

const DEFAULT_CLASSIFICATION: Record<WorkflowKind, string> = {
  intsum: "restricted",
  aar: "unclassified",
};

export const WORKFLOW_USAGE: Record<WorkflowKind, string> = {
  intsum: "Usage: !intsum [-s] [class:<level>] <key points — separate with ; or |>",
  aar: "Usage: !aar [-s] [class:<level>] <key points — separate with ; or |>",
};

/** System prompts per doc type — kept separate from the general analyst persona. */
export const WORKFLOW_SYSTEM_PROMPTS: Record<WorkflowKind, string> = {
  intsum:
    "You draft short intelligence summaries (INTSUMs) for an operations community. " +
    "The operator supplies bullet key points; expand them into a concise, professional INTSUM. " +
    "Output ONLY valid Markdown: YAML frontmatter (classification, tags, valid_until) then body sections. " +
    "Use ## headings. Stay factual — do not invent events beyond what the bullets imply; mark gaps as unknown. " +
    "Keep it under ~600 words. valid_until should be ~30 days from today unless bullets specify otherwise.",
  aar:
    "You draft short After-Action Reports (AARs) for an operations community. " +
    "The operator supplies bullet key points; expand them into a structured AAR. " +
    "Output ONLY valid Markdown: YAML frontmatter (classification, tags) then body sections. " +
    "Cover mission/objectives, execution, what went well, what didn't, and concrete lessons/recommendations. " +
    "Stay factual — do not invent events beyond what the bullets imply. Keep it under ~700 words.",
};

const WORKFLOW_SKELETONS: Record<WorkflowKind, string> = {
  intsum: `---
classification: <level>
tags: [intel, intsum]
valid_until: <YYYY-MM-DD>
---

# INTSUM <date>

## Executive Summary

## Key Judgments

## Situation

## Assessment

## Outlook`,
  aar: `---
classification: <level>
tags: [aar, after-action]
---

# After-Action Report — <title>

## Mission / Objectives

## Execution

## What Went Well

## What Didn't / Friction

## Lessons & Recommendations`,
};

/** Parse `!intsum` / `!aar` args and flags into a workflow request. */
export function parseWorkflowCommand(
  kind: WorkflowKind,
  cmd: Pick<ParsedCommand, "args" | "flags">,
): WorkflowRequest | { error: string } {
  let raw = cmd.args.trim();
  if (!raw) return { error: WORKFLOW_USAGE[kind] };

  let classification = DEFAULT_CLASSIFICATION[kind];
  const classMatch = raw.match(/\bclass:([a-z][a-z0-9_-]*)\b/i);
  if (classMatch) {
    classification = classMatch[1].toLowerCase();
    raw = raw.replace(classMatch[0], " ").replace(/\s+/g, " ").trim();
  }
  if (!raw) return { error: WORKFLOW_USAGE[kind] };

  const bullets = splitBullets(raw);
  if (bullets.length === 0) return { error: WORKFLOW_USAGE[kind] };

  return {
    kind,
    bullets,
    classification,
    save: cmd.flags.has("s"),
  };
}

function splitBullets(text: string): string[] {
  const sep = text.includes("|") ? "|" : text.includes(";") ? ";" : null;
  const parts = sep ? text.split(sep) : [text];
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** User message sent to the delegate model. */
export function buildWorkflowTask(req: WorkflowRequest): string {
  const bulletBlock = req.bullets.map((b, i) => `${i + 1}. ${b}`).join("\n");
  const today = new Date().toISOString().slice(0, 10);
  return [
    `Draft a ${req.kind.toUpperCase()} using this skeleton (fill every section; adjust title/date):`,
    "",
    WORKFLOW_SKELETONS[req.kind].replace("<level>", req.classification).replace("<date>", today),
    "",
    "Operator key points:",
    bulletBlock,
    "",
    `Set classification in frontmatter to: ${req.classification}`,
    "Reply with the finished Markdown document only — no preamble or commentary.",
  ].join("\n");
}

/** Doctrine path for `-s` saves. */
export function workflowSavePath(kind: WorkflowKind, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  const folder = kind === "intsum" ? "intel" : "reports";
  return `${folder}/${kind}-${date}.md`;
}

/** Prefix for async workflow follow-ups (same pattern as DESIGN §R1b). */
export function formatWorkflowFollowUp(
  kind: WorkflowKind,
  result: string,
  invokerName?: string,
): string {
  const label = invokerName ? `${kind.toUpperCase()} (${invokerName})` : kind.toUpperCase();
  return `📋 ${label}:\n${result}`;
}

export const WORKFLOW_ACK_MESSAGE = "Drafting — I'll post the document here when ready.";
