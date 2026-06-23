import type Database from "better-sqlite3";
import { extractSubject, isFactActiveAt } from "./kg-parse.js";

export type KgDiary = "intel" | "logistics" | null;

export interface KgFact {
  id: number;
  subject: string;
  fact: string;
  validFrom: string | null;
  validUntil: string | null;
  diary: KgDiary;
  createdByUid: string | null;
  createdAt: number;
}

/**
 * Institutional temporal knowledge graph (ROADMAP Phase 7).
 * Org-wide facts with optional validity windows — separate from per-user `!remember`.
 */
export class KgStore {
  private addStmt: Database.Statement;
  private listStmt: Database.Statement;
  private searchStmt: Database.Statement;
  private forgetStmt: Database.Statement;
  private forgetOneStmt: Database.Statement;
  private allStmt: Database.Statement;

  constructor(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kg_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        fact TEXT NOT NULL,
        valid_from TEXT,
        valid_until TEXT,
        diary TEXT,
        created_by_uid TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kg_subject ON kg_facts(subject);
      CREATE INDEX IF NOT EXISTS idx_kg_created ON kg_facts(created_at DESC);
    `);
    this.addStmt = db.prepare(`
      INSERT INTO kg_facts (subject, fact, valid_from, valid_until, diary, created_by_uid, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.listStmt = db.prepare(
      `SELECT * FROM kg_facts ORDER BY created_at DESC, id DESC LIMIT ?`,
    );
    this.searchStmt = db.prepare(
      `SELECT * FROM kg_facts
       WHERE subject LIKE ? OR fact LIKE ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    );
    this.forgetStmt = db.prepare(`DELETE FROM kg_facts`);
    this.forgetOneStmt = db.prepare(`DELETE FROM kg_facts WHERE id = ?`);
    this.allStmt = db.prepare(`SELECT * FROM kg_facts ORDER BY id ASC`);
  }

  add(opts: {
    fact: string;
    subject?: string;
    validFrom?: string | null;
    validUntil?: string | null;
    diary?: KgDiary;
    createdByUid?: string | null;
  }): KgFact {
    const subject = (opts.subject ?? extractSubject(opts.fact)).slice(0, 120);
    const fact = opts.fact.slice(0, 500);
    const now = Date.now();
    const info = this.addStmt.run(
      subject,
      fact,
      opts.validFrom ?? null,
      opts.validUntil ?? null,
      opts.diary ?? null,
      opts.createdByUid ?? null,
      now,
    );
    return {
      id: Number(info.lastInsertRowid),
      subject,
      fact,
      validFrom: opts.validFrom ?? null,
      validUntil: opts.validUntil ?? null,
      diary: opts.diary ?? null,
      createdByUid: opts.createdByUid ?? null,
      createdAt: now,
    };
  }

  list(limit = 20): KgFact[] {
    return (this.listStmt.all(limit) as KgRow[]).map(rowToFact);
  }

  /** Subject/temporal query — `asOf` defaults to today (UTC). */
  querySubject(subject: string, asOf?: string, limit = 20): KgFact[] {
    const needle = subject.trim();
    if (!needle) return [];
    const like = `%${needle}%`;
    const refDate = asOf?.trim() || new Date().toISOString().slice(0, 10);
    return (this.searchStmt.all(like, like, Math.max(limit, 50)) as KgRow[])
      .map(rowToFact)
      .filter((f) => isFactActiveAt(f.validFrom, f.validUntil, refDate))
      .slice(0, limit);
  }

  /** Semantic pre-filter: facts whose text matches any token in the question. */
  searchText(question: string, asOf?: string, limit = 8): KgFact[] {
    const tokens = question
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((t) => t.length >= 3)
      .slice(0, 6);
    if (tokens.length === 0) return this.list(limit);
    const refDate = asOf?.trim() || new Date().toISOString().slice(0, 10);
    const seen = new Set<number>();
    const hits: KgFact[] = [];
    for (const token of tokens) {
      for (const row of this.searchStmt.all(`%${token}%`, `%${token}%`, 30) as KgRow[]) {
        const f = rowToFact(row);
        if (seen.has(f.id)) continue;
        if (!isFactActiveAt(f.validFrom, f.validUntil, refDate)) continue;
        seen.add(f.id);
        hits.push(f);
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  allFacts(): KgFact[] {
    return (this.allStmt.all() as KgRow[]).map(rowToFact);
  }

  forgetAll(): number {
    return this.forgetStmt.run().changes;
  }

  forgetAtIndex(index: number): boolean {
    if (index < 1) return false;
    const rows = this.list(100);
    const row = rows[index - 1];
    if (!row) return false;
    return this.forgetOneStmt.run(row.id).changes > 0;
  }
}

interface KgRow {
  id: number;
  subject: string;
  fact: string;
  valid_from: string | null;
  valid_until: string | null;
  diary: string | null;
  created_by_uid: string | null;
  created_at: number;
}

function rowToFact(r: KgRow): KgFact {
  const diary = r.diary === "intel" || r.diary === "logistics" ? r.diary : null;
  return {
    id: r.id,
    subject: r.subject,
    fact: r.fact,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    diary,
    createdByUid: r.created_by_uid,
    createdAt: r.created_at,
  };
}