/**
 * Procedural playbook store (P3) — capture successful tool patterns, retrieve by hints.
 * No LoRA; pure retrieval for small-model prompts.
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

const SECRETISH = /(password|token|secret|api[_-]?key|authorization)/i;

export function stripSecrets(text: string): string {
  if (SECRETISH.test(text)) return "[redacted]";
  return text.slice(0, 500);
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
    const tools = input.tools.map(stripSecrets).filter(Boolean);
    if (tools.length === 0) return null;
    const hints = input.hints.map(stripSecrets).filter(Boolean);
    if (hints.length === 0) return null;

    // Template dedup: same tools+first hint
    const key = `${tools.join(",")}|${hints[0]}`;
    const existing = this.items.find((p) => `${p.tools.join(",")}|${p.triggerHints[0]}` === key);
    if (existing) {
      existing.createdAt = Date.now();
      this.save();
      return existing;
    }

    const pb: Playbook = {
      id: `pb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      triggerHints: hints.slice(0, 8),
      steps: (input.steps ?? tools).map(stripSecrets).slice(0, 12),
      tools,
      outcome: "ok",
      createdAt: Date.now(),
    };
    this.items.unshift(pb);
    if (this.items.length > this.maxStore) this.items = this.items.slice(0, this.maxStore);
    this.save();
    return pb;
  }

  /** Keyword/hint overlap retrieve (no embeddings required). */
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
