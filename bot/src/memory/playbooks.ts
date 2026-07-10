/**
 * Procedural playbook store (P3) — capture successful tool patterns, retrieve by hints.
 * No LoRA; pure retrieval for small-model prompts.
 * L-PB-1: store tool names only; strip secrets aggressively; never free-form args.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Playbook {
  id: string;
  triggerHints: string[];
  steps: string[];
  tools: string[];
  outcome: "ok" | "fail";
  createdAt: number;
}

export interface PlaybookStoreOptions {
  path: string;
  maxStore?: number;
}

/** Whole-string secret keywords. */
const SECRETISH = /(password|token|secret|api[_-]?key|authorization|bearer|credential)/i;
/** Inline secret-like assignments / long hex blobs. */
const INLINE_SECRET = /(?:password|token|secret|api[_-]?key|authorization|bearer)\s*[:=]\s*\S+/gi;
const LONG_HEX = /\b[a-f0-9]{32,}\b/gi;
const SAFE_TOOL = /^[a-z][a-z0-9_.-]{0,63}$/i;

export function stripSecrets(text: string): string {
  if (!text || SECRETISH.test(text)) return "[redacted]";
  let out = text.slice(0, 500);
  out = out.replace(INLINE_SECRET, "[redacted]");
  out = out.replace(LONG_HEX, "[redacted]");
  return out;
}

/** Only allow safe tool identifiers — never raw arguments. */
export function sanitizeToolName(name: string): string | null {
  const n = name.trim().toLowerCase();
  if (!SAFE_TOOL.test(n)) return null;
  if (SECRETISH.test(n)) return null;
  return n;
}

export class PlaybookStore {
  private path: string;
  private maxStore: number;
  private items: Playbook[] = [];

  constructor(opts: PlaybookStoreOptions) {
    this.path = opts.path;
    this.maxStore = opts.maxStore ?? 200;
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Playbook[];
      if (Array.isArray(raw)) this.items = raw;
    } catch {
      this.items = [];
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.items, null, 2), "utf8");
    } catch {
      /* fail-open */
    }
  }

  capture(input: {
    hints: string[];
    tools: string[];
    steps?: string[];
    outcome?: "ok" | "fail";
  }): Playbook | null {
    if (input.outcome === "fail") return null;
    // L-PB-1: tool names only — never store free-form argument strings as tools
    const tools = input.tools.map((t) => sanitizeToolName(t)).filter((t): t is string => !!t);
    if (tools.length === 0) return null;
    const hints = input.hints
      .map((h) => stripSecrets(h))
      .filter((h) => h && h !== "[redacted]")
      .slice(0, 8);
    if (hints.length === 0) return null;

    // Steps default to tool names only (not raw LLM prose)
    const steps = (input.steps ?? tools)
      .map((s) => {
        const asTool = sanitizeToolName(s);
        return asTool ?? stripSecrets(s);
      })
      .filter((s) => s && s !== "[redacted]")
      .slice(0, 12);

    const key = `${tools.join(",")}|${hints[0]}`;
    const existing = this.items.find((p) => `${p.tools.join(",")}|${p.triggerHints[0]}` === key);
    if (existing) {
      existing.createdAt = Date.now();
      this.save();
      return existing;
    }

    const pb: Playbook = {
      id: `pb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      triggerHints: hints,
      steps: steps.length ? steps : tools,
      tools,
      outcome: "ok",
      createdAt: Date.now(),
    };
    this.items.unshift(pb);
    if (this.items.length > this.maxStore) this.items = this.items.slice(0, this.maxStore);
    this.save();
    return pb;
  }

  retrieve(query: string, k = 2): Playbook[] {
    const q = query.toLowerCase();
    const words = q.split(/\s+/).filter((w) => w.length > 2);
    if (words.length === 0) return [];
    const scored = this.items.map((p) => {
      const blob = [...p.triggerHints, ...p.tools, ...p.steps].join(" ").toLowerCase();
      let score = 0;
      for (const w of words) {
        if (blob.includes(w)) score += 1;
      }
      return { p, score };
    });
    return scored
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.p);
  }

  list(): Playbook[] {
    return [...this.items];
  }
}
