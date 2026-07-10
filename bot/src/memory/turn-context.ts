/**
 * Typed turn context assembly + injection dedup (P2 design).
 * Hard budgets per memory type; never re-inject the same id in a session.
 */

export type MemoryType =
  | "working"
  | "doctrine"
  | "org_kg"
  | "user_private"
  | "last_tools"
  | "playbook";

export interface MemoryCandidate {
  id: string;
  type: MemoryType;
  text: string;
  score?: number;
  source?: string;
}

export interface MemoryBudgets {
  workingTurns?: number;
  doctrineChunks?: number;
  orgKgHits?: number;
  playbooks?: number;
  lastTools?: number;
}

export const DEFAULT_MEMORY_BUDGETS: Required<MemoryBudgets> = {
  workingTurns: 6,
  doctrineChunks: 6,
  orgKgHits: 4,
  playbooks: 2,
  lastTools: 3,
};

export type InjectionLog = Set<string>;

export function injectionKey(type: MemoryType, id: string): string {
  return `${type}:${id}`;
}

/**
 * Select up to `budget` candidates by score (desc), skipping ids already in log.
 * Mutates `log` with newly selected keys when `dedupe` is true.
 */
export function selectWithDedup(
  candidates: MemoryCandidate[],
  log: InjectionLog,
  budget: number,
  dedupe = true,
): MemoryCandidate[] {
  if (budget <= 0) return [];
  const sorted = [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const out: MemoryCandidate[] = [];
  for (const c of sorted) {
    if (out.length >= budget) break;
    const key = injectionKey(c.type, c.id);
    if (dedupe && log.has(key)) continue;
    out.push(c);
    if (dedupe) log.add(key);
  }
  return out;
}

export interface AssembleTurnContextInput {
  doctrine?: MemoryCandidate[];
  orgKg?: MemoryCandidate[];
  userPrivate?: MemoryCandidate[];
  lastTools?: MemoryCandidate[];
  playbooks?: MemoryCandidate[];
  budgets?: MemoryBudgets;
  /** Session injection log (mutated). */
  injectionLog?: InjectionLog;
  dedupeInjections?: boolean;
}

export interface AssembleTurnContextResult {
  /** Blocks suitable for system messages (ordered). */
  systemBlocks: string[];
  selected: MemoryCandidate[];
  /** Keys skipped due to dedup this pass. */
  skippedDedup: number;
  injectionLog: InjectionLog;
}

function budgetFor(type: MemoryType, b: Required<MemoryBudgets>): number {
  switch (type) {
    case "doctrine":
      return b.doctrineChunks;
    case "org_kg":
      return b.orgKgHits;
    case "playbook":
      return b.playbooks;
    case "last_tools":
      return b.lastTools;
    case "user_private":
      return b.orgKgHits; // same small budget family
    default:
      return 4;
  }
}

/**
 * Assemble typed memory slices for one LLM turn.
 * Working history is capped separately via `capWorkingTurns`.
 */
export function assembleTurnContext(input: AssembleTurnContextInput): AssembleTurnContextResult {
  const budgets = { ...DEFAULT_MEMORY_BUDGETS, ...input.budgets };
  const log = input.injectionLog ?? new Set<string>();
  const dedupe = input.dedupeInjections !== false;
  const selected: MemoryCandidate[] = [];
  let skippedDedup = 0;

  const groups: { type: MemoryType; items: MemoryCandidate[] }[] = [
    { type: "doctrine", items: input.doctrine ?? [] },
    { type: "org_kg", items: input.orgKg ?? [] },
    { type: "user_private", items: input.userPrivate ?? [] },
    { type: "playbook", items: input.playbooks ?? [] },
    { type: "last_tools", items: input.lastTools ?? [] },
  ];

  for (const g of groups) {
    if (g.items.length === 0) continue;
    const before = g.items.length;
    const tagged = g.items.map((c) => ({ ...c, type: g.type }));
    // Count would-be skips
    if (dedupe) {
      for (const c of tagged) {
        if (log.has(injectionKey(g.type, c.id))) skippedDedup += 1;
      }
    }
    const picked = selectWithDedup(tagged, log, budgetFor(g.type, budgets), dedupe);
    selected.push(...picked);
    void before;
  }

  const systemBlocks: string[] = [];
  const byType = new Map<MemoryType, MemoryCandidate[]>();
  for (const c of selected) {
    const list = byType.get(c.type) ?? [];
    list.push(c);
    byType.set(c.type, list);
  }

  const labels: Partial<Record<MemoryType, string>> = {
    doctrine: "Doctrine / knowledge base",
    org_kg: "Org knowledge graph",
    user_private: "Private user memory",
    playbook: "Ops playbooks (how we do this)",
    last_tools: "Recent tools",
  };

  for (const type of [
    "doctrine",
    "org_kg",
    "user_private",
    "playbook",
    "last_tools",
  ] as MemoryType[]) {
    const items = byType.get(type);
    if (!items?.length) continue;
    const body = items
      .map((c) => {
        const src = c.source ? `[${c.source}] ` : "";
        return `${src}${c.text}`;
      })
      .join("\n\n");
    systemBlocks.push(
      `${labels[type] ?? type} — ground answers in this when applicable; do not invent facts.\n\n${body}`,
    );
  }

  return { systemBlocks, selected, skippedDedup, injectionLog: log };
}

/** Keep the last N user+assistant pairs (2N messages). */
export function capWorkingTurns<T>(messages: T[], workingTurns: number): T[] {
  if (workingTurns <= 0) return [];
  // Each "turn" ≈ user + assistant = 2 messages when history is pairs.
  const maxMessages = workingTurns * 2;
  if (messages.length <= maxMessages) return messages;
  return messages.slice(-maxMessages);
}
