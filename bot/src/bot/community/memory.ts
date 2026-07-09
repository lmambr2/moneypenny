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

export interface MemorySyncResult {
  synced: number;
  failed: number;
  skipped: boolean;
  total: number;
}

/** Per-user memory commands (ROADMAP Phase 7). SQLite MVP + optional MemPalace. */
export class MemoryService {
  private lastSync: MemorySyncResult | null = null;
  private lastSyncAt: number | null = null;

  constructor(private deps: MemoryServiceDeps) {}

  setMemPalace(client: MemPalaceClient | null, enabled: boolean, url?: string): void {
    this.deps.mempalace = client;
    this.deps.config.mempalaceEnabled = enabled;
    if (url !== undefined) this.deps.config.mempalaceUrl = url;
  }

  private useMemPalace(): boolean {
    return !!this.deps.config.mempalaceEnabled && !!this.deps.mempalace;
  }

  getLastSync(): { result: MemorySyncResult; at: number } | null {
    if (!this.lastSync || this.lastSyncAt == null) return null;
    return { result: this.lastSync, at: this.lastSyncAt };
  }

  async handleRemember(args: string, invokerUid?: string): Promise<string> {
    const fact = args?.trim();
    if (!fact) return "Usage: !remember <something about you>";
    if (!invokerUid) return "Couldn't identify you — nothing saved.";

    this.deps.store.add(invokerUid, fact);

    let mpOk: boolean | null = null;
    if (this.useMemPalace()) {
      mpOk = await this.deps.mempalace!.remember(invokerUid, fact);
      if (!mpOk) {
        this.deps.logger?.warn({ invokerUid }, "MemPalace remember sync failed — SQLite copy kept");
      }
    }

    if (this.useMemPalace()) {
      if (mpOk === false) {
        return this.deps.config.memoryEnabled
          ? "Noted locally — MemPalace sync failed; try Sync in Settings later."
          : "Noted locally (MemPalace sync failed; memory injection is off).";
      }
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

  async handleForget(args: string, invokerUid?: string): Promise<string> {
    if (!invokerUid) return "Couldn't identify you.";
    const trimmed = args?.trim().toLowerCase();
    if (!trimmed) return "Usage: !forget <number> or !forget all";

    if (trimmed === "all") {
      const n = this.deps.store.forget(invokerUid);
      let mpNote = "";
      if (this.useMemPalace()) {
        const ok = await this.deps.mempalace!.forget(invokerUid, { all: true });
        if (!ok) {
          this.deps.logger?.warn({ invokerUid }, "MemPalace forget-all failed");
          mpNote = " (MemPalace may still have copies — re-run Sync or forget again)";
        }
      }
      return n > 0
        ? `Forgotten ${n} fact${n === 1 ? "" : "s"}.${mpNote}`
        : "Nothing to forget.";
    }

    const index = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(index) || index < 1) {
      return "Usage: !forget <number> (from !recall) or !forget all";
    }

    // Delete MemPalace first while indices still match its recall order, then SQLite.
    let mpOk: boolean | null = null;
    if (this.useMemPalace()) {
      mpOk = await this.deps.mempalace!.forget(invokerUid, { index });
      if (!mpOk) {
        this.deps.logger?.warn({ invokerUid, index }, "MemPalace forget-index failed");
      }
    }

    const localOk = this.deps.store.forgetAtIndex(invokerUid, index);
    if (!localOk && mpOk !== true) {
      return "No fact at that number — run !recall to see your list.";
    }
    if (localOk && mpOk === false) {
      return "Forgotten locally; MemPalace may still have it — check !recall or Sync.";
    }
    return "Forgotten.";
  }

  /** Push every SQLite fact to MemPalace (idempotent — duplicates are skipped server-side). */
  async syncToMemPalace(): Promise<MemorySyncResult> {
    if (!this.useMemPalace()) {
      const empty: MemorySyncResult = { synced: 0, failed: 0, skipped: true, total: 0 };
      this.lastSync = empty;
      this.lastSyncAt = Date.now();
      return empty;
    }
    const all = this.deps.store.allFacts();
    let synced = 0;
    let failed = 0;
    for (const fact of all) {
      const ok = await this.deps.mempalace!.remember(fact.userUid, fact.fact);
      if (ok) synced++;
      else failed++;
    }
    const result: MemorySyncResult = {
      synced,
      failed,
      skipped: false,
      total: all.length,
    };
    this.lastSync = result;
    this.lastSyncAt = Date.now();
    return result;
  }

  private formatRecall(facts: string[]): string {
    return "What I remember about you:\n" + facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
  }
}
