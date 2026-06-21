import type { BotConfig } from "../../data/config.js";
import type { MemoryStore } from "../../data/memory.js";
import type { MemPalaceClient } from "../../memory/mempalace-client.js";
import type { Logger } from "../../logger.js";

export interface MemoryServiceDeps {
  store: MemoryStore;
  config: BotConfig;
  mempalace?: MemPalaceClient | null;
  logger?: Logger;
}

/** Per-user memory commands (ROADMAP Phase 7). SQLite MVP + optional MemPalace. */
export class MemoryService {
  constructor(private deps: MemoryServiceDeps) {}

  setMemPalace(client: MemPalaceClient | null, enabled: boolean, url?: string): void {
    this.deps.mempalace = client;
    this.deps.config.mempalaceEnabled = enabled;
    if (url !== undefined) this.deps.config.mempalaceUrl = url;
  }

  private useMemPalace(): boolean {
    return !!this.deps.config.mempalaceEnabled && !!this.deps.mempalace;
  }

  handleRemember(args: string, invokerUid?: string): string {
    const fact = args?.trim();
    if (!fact) return "Usage: !remember <something about you>";
    if (!invokerUid) return "Couldn't identify you — nothing saved.";

    this.deps.store.add(invokerUid, fact);
    if (this.useMemPalace()) {
      void this.deps.mempalace!.remember(invokerUid, fact).then((ok) => {
        if (!ok) this.deps.logger?.warn({ invokerUid }, "MemPalace remember sync failed — SQLite copy kept");
      });
    }

    if (this.useMemPalace()) {
      return this.deps.config.memoryEnabled
        ? "Noted — filed in MemPalace and ready for semantic recall."
        : "Noted in MemPalace (memory injection is off in Settings).";
    }

    return this.deps.config.memoryEnabled
      ? "Noted — I shan't forget, darling."
      : "Noted (memory injection is off; an admin can enable it in Settings).";
  }

  async handleRecall(invokerUid?: string): Promise<string> {
    if (!invokerUid) return "Couldn't identify you.";

    if (this.useMemPalace()) {
      const facts = await this.deps.mempalace!.recall(invokerUid, 15);
      if (facts.length > 0) return this.formatRecall(facts.map((f) => f.fact));
    }

    const local = this.deps.store.recall(invokerUid, 15);
    if (local.length === 0) return "I've nothing on you yet. Use !remember <fact>.";
    return this.formatRecall(local.map((f) => f.fact));
  }

  handleForget(args: string, invokerUid?: string): string {
    if (!invokerUid) return "Couldn't identify you.";
    const trimmed = args?.trim().toLowerCase();
    if (!trimmed) return "Usage: !forget <number> or !forget all";

    if (trimmed === "all") {
      const n = this.deps.store.forget(invokerUid);
      if (this.useMemPalace()) {
        void this.deps.mempalace!.forget(invokerUid, { all: true });
      }
      return n > 0 ? `Forgotten ${n} fact${n === 1 ? "" : "s"}.` : "Nothing to forget.";
    }

    const index = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(index) || index < 1) {
      return "Usage: !forget <number> (from !recall) or !forget all";
    }

    if (this.useMemPalace()) {
      void this.deps.mempalace!.forget(invokerUid, { index });
    }

    return this.deps.store.forgetAtIndex(invokerUid, index)
      ? "Forgotten."
      : "No fact at that number — run !recall to see your list.";
  }

  /** Push every SQLite fact to MemPalace (idempotent — duplicates are skipped server-side). */
  async syncToMemPalace(): Promise<{ synced: number; failed: number; skipped: boolean }> {
    if (!this.useMemPalace()) {
      return { synced: 0, failed: 0, skipped: true };
    }
    let synced = 0;
    let failed = 0;
    for (const fact of this.deps.store.allFacts()) {
      const ok = await this.deps.mempalace!.remember(fact.userUid, fact.fact);
      if (ok) synced++;
      else failed++;
    }
    return { synced, failed, skipped: false };
  }

  private formatRecall(facts: string[]): string {
    return "What I remember about you:\n" + facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
  }
}