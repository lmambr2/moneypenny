import type { BotConfig } from "../../data/config.js";
import type { KgStore } from "../../data/kg.js";
import {
  displayFactLine,
  extractSubject,
  formatKgRecord,
  isIsoDate,
  parseKgFlags,
} from "../../data/kg-parse.js";
import type { Logger } from "../../logger.js";
import type { MemPalaceClient } from "../../memory/mempalace-client.js";

export interface KgServiceDeps {
  store: KgStore;
  config: BotConfig;
  mempalace?: MemPalaceClient | null;
  logger?: Logger;
}

/** Institutional knowledge graph + specialist diaries (ROADMAP Phase 7). */
export class KgService {
  constructor(private deps: KgServiceDeps) {}

  setMemPalace(client: MemPalaceClient | null): void {
    this.deps.mempalace = client;
  }

  updateKg(enabled: boolean): void {
    this.deps.config.kgEnabled = enabled;
  }

  private useMemPalace(): boolean {
    return !!this.deps.config.mempalaceEnabled && !!this.deps.mempalace;
  }

  handleKg(args: string, invokerUid?: string, canRun?: (commandName: string) => boolean): string {
    const trimmed = args.trim();
    if (!trimmed) return KgService.USAGE;

    const space = trimmed.indexOf(" ");
    const sub = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
    const rest = space < 0 ? "" : trimmed.slice(space + 1).trim();

    switch (sub) {
      case "remember":
        return this.handleRemember(rest, invokerUid, undefined, canRun);
      case "who":
        return this.handleWho(rest);
      case "list":
        return this.handleList(rest);
      case "forget":
        return this.handleForget(rest, canRun);
      default:
        return KgService.USAGE;
    }
  }

  handleDiary(
    args: string,
    invokerUid?: string,
    canRun?: (commandName: string) => boolean,
  ): string {
    if (!this.canWrite(canRun)) {
      return "Diary entries require analyst rights (@analyst).";
    }
    const trimmed = args.trim();
    const space = trimmed.indexOf(" ");
    if (space < 0)
      return "Usage: !diary <intel|logistics> <fact> [from:YYYY-MM-DD] [until:YYYY-MM-DD]";
    const diary = trimmed.slice(0, space).toLowerCase();
    if (diary !== "intel" && diary !== "logistics") {
      return "Usage: !diary <intel|logistics> <fact> [from:YYYY-MM-DD] [until:YYYY-MM-DD]";
    }
    return this.handleRemember(trimmed.slice(space + 1), invokerUid, diary, canRun);
  }

  private canWrite(canRun?: (commandName: string) => boolean): boolean {
    if (!canRun) return true;
    return canRun("analyst") || canRun("agent");
  }

  private handleRemember(
    raw: string,
    invokerUid?: string,
    diary?: "intel" | "logistics",
    canRun?: (commandName: string) => boolean,
  ): string {
    if (!this.canWrite(canRun)) {
      return "Recording org facts requires analyst rights (@analyst).";
    }
    const parsed = parseKgFlags(raw);
    const fact = parsed.text;
    if (!fact) {
      return diary
        ? "Usage: !diary <intel|logistics> <fact> [from:YYYY-MM-DD] [until:YYYY-MM-DD]"
        : "Usage: !kg remember <fact> [from:YYYY-MM-DD] [until:YYYY-MM-DD]";
    }
    if (parsed.from && !isIsoDate(parsed.from)) return "Invalid from: date — use YYYY-MM-DD.";
    if (parsed.until && !isIsoDate(parsed.until)) return "Invalid until: date — use YYYY-MM-DD.";

    const subject = extractSubject(fact);
    const diaryTag = diary ?? parsed.diary ?? null;
    const row = this.deps.store.add({
      fact,
      subject,
      validFrom: parsed.from ?? null,
      validUntil: parsed.until ?? null,
      diary: diaryTag,
      createdByUid: invokerUid ?? null,
    });

    if (this.useMemPalace()) {
      const line = formatKgRecord({
        subject: row.subject,
        fact: row.fact,
        validFrom: row.validFrom,
        validUntil: row.validUntil,
        diary: row.diary,
      });
      void this.deps
        .mempalace!.kgRemember(line, {
          validFrom: row.validFrom,
          validUntil: row.validUntil,
          diary: row.diary,
          subject: row.subject,
        })
        .then((ok) => {
          if (!ok)
            this.deps.logger?.warn(
              { subject: row.subject },
              "MemPalace KG sync failed — SQLite kept",
            );
        });
    }

    const label = diaryTag ? `${diaryTag} diary` : "org KG";
    return `Recorded in ${label}: ${displayFactLine(row.fact, row.validFrom, row.validUntil)}`;
  }

  private handleWho(raw: string): string {
    const parsed = parseKgFlags(raw);
    const subject = parsed.text;
    if (!subject) return "Usage: !kg who <name or role> [asof:YYYY-MM-DD]";
    if (parsed.asOf && !isIsoDate(parsed.asOf)) return "Invalid asof: date — use YYYY-MM-DD.";

    const asOf = parsed.asOf ?? new Date().toISOString().slice(0, 10);
    const facts = this.deps.store.querySubject(subject, asOf, 15);
    if (facts.length === 0) {
      return `No org records for "${subject}" as of ${asOf}.`;
    }
    const lines = facts.map(
      (f, i) =>
        `${i + 1}. ${displayFactLine(f.fact, f.validFrom, f.validUntil)}` +
        (f.diary ? ` [${f.diary}]` : ""),
    );
    return `Org knowledge as of ${asOf} for "${subject}":\n${lines.join("\n")}`;
  }

  private handleList(raw: string): string {
    const limit = Math.min(30, Math.max(1, Number.parseInt(raw.trim(), 10) || 15));
    const facts = this.deps.store.list(limit);
    if (facts.length === 0) return "Org knowledge graph is empty. Analysts: !kg remember <fact>.";
    const lines = facts.map(
      (f, i) =>
        `${i + 1}. ${displayFactLine(f.fact, f.validFrom, f.validUntil)}` +
        (f.diary ? ` [${f.diary}]` : ""),
    );
    return `Recent org knowledge (${facts.length}):\n${lines.join("\n")}`;
  }

  private handleForget(raw: string, canRun?: (commandName: string) => boolean): string {
    if (!this.canWrite(canRun)) {
      return "Forgetting org facts requires analyst rights (@analyst).";
    }
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "all") {
      const n = this.deps.store.forgetAll();
      return n > 0 ? `Purged ${n} org fact${n === 1 ? "" : "s"}.` : "Nothing to forget.";
    }
    const index = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(index) || index < 1) {
      return "Usage: !kg forget <number> (from !kg list) or !kg forget all";
    }
    return this.deps.store.forgetAtIndex(index)
      ? "Forgotten."
      : "No fact at that number — run !kg list.";
  }

  /**
   * Org-scoped search for memory bumpers (R4). MemPalace kgSearch first, then
   * SQLite KG. Never touches per-user !remember rooms.
   */
  async searchOrg(query: string, limit = 5): Promise<Array<{ fact: string }>> {
    const q = query.trim();
    if (!q) return [];

    if (this.useMemPalace()) {
      const hits = await this.deps.mempalace!.kgSearch(q, { limit });
      if (hits.length > 0) {
        return hits.map((h) => ({ fact: h.fact }));
      }
    }

    if (!this.deps.config.kgEnabled) return [];
    return this.deps.store
      .searchText(q, undefined, limit)
      .map((f) => ({ fact: displayFactLine(f.fact, f.validFrom, f.validUntil) }));
  }

  /** List recent org facts (dashboard / API). */
  listFacts(limit = 20): Array<{
    id: number;
    subject: string;
    fact: string;
    validFrom: string | null;
    validUntil: string | null;
    diary: string | null;
  }> {
    return this.deps.store.list(limit).map((f) => ({
      id: f.id,
      subject: f.subject,
      fact: f.fact,
      validFrom: f.validFrom,
      validUntil: f.validUntil,
      diary: f.diary,
    }));
  }

  /**
   * Seed an org fact and await MemPalace sync when enabled (R4 API path).
   * Returns the human message from handleRemember.
   */
  async seedOrgFact(
    fact: string,
    invokerUid?: string,
  ): Promise<{ ok: boolean; message: string; syncedToMemPalace: boolean }> {
    const msg = this.handleRemember(fact, invokerUid, undefined, () => true);
    if (msg.startsWith("Usage:") || msg.startsWith("Recording org")) {
      return { ok: false, message: msg, syncedToMemPalace: false };
    }
    let syncedToMemPalace = false;
    if (this.useMemPalace()) {
      const row = this.deps.store.list(1)[0];
      if (row) {
        const line = formatKgRecord({
          subject: row.subject,
          fact: row.fact,
          validFrom: row.validFrom,
          validUntil: row.validUntil,
          diary: row.diary,
        });
        syncedToMemPalace = await this.deps.mempalace!.kgRemember(line, {
          validFrom: row.validFrom,
          validUntil: row.validUntil,
          diary: row.diary,
          subject: row.subject,
        });
      }
    }
    return { ok: true, message: msg, syncedToMemPalace };
  }

  /** Facts to inject into !ask / delegate retrieval. */
  async recallForQuestion(question: string): Promise<Array<{ text: string; source: string }>> {
    if (!this.deps.config.kgEnabled) return [];

    const asOfMatch = question.match(/\bas\s+of\s+(\d{4}-\d{2}-\d{2})\b/i);
    const asOf = asOfMatch?.[1];

    if (this.useMemPalace()) {
      const hits = await this.deps.mempalace!.kgSearch(question, { asOf, limit: 8 });
      if (hits.length > 0) {
        return hits.map((h) => ({
          text: h.fact,
          source: h.diary ? `org memory (${h.diary})` : "org knowledge graph",
        }));
      }
    }

    const facts = this.deps.store.searchText(question, asOf, 8);
    return facts.map((f) => ({
      text: displayFactLine(f.fact, f.validFrom, f.validUntil),
      source: f.diary ? `org memory (${f.diary})` : "org knowledge graph",
    }));
  }

  /** Push every SQLite KG fact to MemPalace (idempotent). */
  async syncToMemPalace(): Promise<{ synced: number; failed: number; skipped: boolean }> {
    if (!this.useMemPalace()) return { synced: 0, failed: 0, skipped: true };
    let synced = 0;
    let failed = 0;
    for (const row of this.deps.store.allFacts()) {
      const line = formatKgRecord({
        subject: row.subject,
        fact: row.fact,
        validFrom: row.validFrom,
        validUntil: row.validUntil,
        diary: row.diary,
      });
      const ok = await this.deps.mempalace!.kgRemember(line, {
        validFrom: row.validFrom,
        validUntil: row.validUntil,
        diary: row.diary,
        subject: row.subject,
      });
      if (ok) synced++;
      else failed++;
    }
    return { synced, failed, skipped: false };
  }

  static readonly USAGE =
    "Usage: !kg remember <fact> [from:YYYY-MM-DD] [until:YYYY-MM-DD] | " +
    "!kg who <name> [asof:YYYY-MM-DD] | !kg list [n] | !kg forget <n|all>";
}
