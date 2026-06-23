import type { ParsedCommand } from "../bot/commands.js";

/** DESIGN §R3 — arbitrary analyst reports with optional doctrine save. */
export interface AnalystRequest {
  task: string;
  save: boolean;
  classification: string;
}

const DEFAULT_CLASSIFICATION = "restricted";

export const ANALYST_USAGE =
  "Usage: !analyst [-s] [class:<level>] <task>  (alias: !agent)";

/** Parse `!analyst` / `!agent` args and flags. */
export function parseAnalystCommand(
  cmd: Pick<ParsedCommand, "args" | "flags">,
): AnalystRequest | { error: string } {
  let raw = cmd.args.trim();
  if (!raw) return { error: ANALYST_USAGE };

  let classification = DEFAULT_CLASSIFICATION;
  const classMatch = raw.match(/\bclass:([a-z][a-z0-9_-]*)\b/i);
  if (classMatch) {
    classification = classMatch[1].toLowerCase();
    raw = raw.replace(classMatch[0], " ").replace(/\s+/g, " ").trim();
  }
  if (!raw) return { error: ANALYST_USAGE };

  return {
    task: raw,
    save: cmd.flags.has("s"),
    classification,
  };
}

/** Doctrine path for `!analyst -s` saves. */
export function analystSavePath(now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return `reports/analyst-${date}.md`;
}

/** Append save status to delegate follow-up (R3). */
export function appendAnalystSaveNotice(
  result: string,
  saved: { ok: true; source: string } | { ok: false; error: string } | null,
): string {
  if (!saved) return result;
  if (saved.ok) {
    return `${result}\n\n💾 Saved to knowledge base: ${saved.source}`;
  }
  return `${result}\n\n⚠️ Could not save: ${saved.error}`;
}