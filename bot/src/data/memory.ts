import type Database from "better-sqlite3";

export interface MemoryFact {
  id: number;
  userUid: string;
  fact: string;
  createdAt: number;
}

/**
 * Minimal per-user memory (ROADMAP Phase 7 / MemPalace, MVP). `!remember <fact>`
 * stores a fact keyed by TS uid; `!recall` lists it; the facts are injected into
 * `!ask` so answers are personalized. Backed by the bot's SQLite db — no new
 * infra. The heavy MemPalace bits (temporal knowledge graph, specialist diaries)
 * are deliberately out of scope here.
 */
export class MemoryStore {
  private addStmt: Database.Statement;
  private recallStmt: Database.Statement;
  private countStmt: Database.Statement;
  private forgetStmt: Database.Statement;
  private forgetOneStmt: Database.Statement;
  private allStmt: Database.Statement;

  constructor(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_uid TEXT NOT NULL,
        fact TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_memory_uid ON user_memory(user_uid);
    `);
    this.addStmt = db.prepare(`INSERT INTO user_memory (user_uid, fact, created_at) VALUES (?, ?, ?)`);
    this.recallStmt = db.prepare(
      // id DESC breaks same-millisecond ties so ordering is deterministically newest-first.
      `SELECT * FROM user_memory WHERE user_uid = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    );
    this.countStmt = db.prepare(`SELECT COUNT(*) AS n FROM user_memory WHERE user_uid = ?`);
    this.forgetStmt = db.prepare(`DELETE FROM user_memory WHERE user_uid = ?`);
    this.forgetOneStmt = db.prepare(`DELETE FROM user_memory WHERE id = ? AND user_uid = ?`);
    this.allStmt = db.prepare(`SELECT * FROM user_memory ORDER BY user_uid ASC, created_at ASC`);
  }

  /** Store a fact for a user. Truncated for sanity. */
  add(userUid: string, fact: string): void {
    this.addStmt.run(userUid, fact.slice(0, 500), Date.now());
  }

  /** All stored facts (for MemPalace backfill). */
  allFacts(): MemoryFact[] {
    return (this.allStmt.all() as MemoryRow[]).map(rowToFact);
  }

  /** A user's facts, newest first. */
  recall(userUid: string, limit = 20): MemoryFact[] {
    return (this.recallStmt.all(userUid, limit) as MemoryRow[]).map(rowToFact);
  }

  count(userUid: string): number {
    return (this.countStmt.get(userUid) as { n: number }).n;
  }

  /** Forget all of a user's facts (returns rows removed). */
  forget(userUid: string): number {
    return this.forgetStmt.run(userUid).changes;
  }

  /** Forget a single fact by id, scoped to its owner. */
  forgetOne(userUid: string, id: number): boolean {
    return this.forgetOneStmt.run(id, userUid).changes > 0;
  }

  /** Forget one fact by its 1-based index in {@link recall} order. */
  forgetAtIndex(userUid: string, index: number): boolean {
    if (index < 1) return false;
    const facts = this.recall(userUid, 100);
    const fact = facts[index - 1];
    if (!fact) return false;
    return this.forgetOne(userUid, fact.id);
  }
}

interface MemoryRow {
  id: number;
  user_uid: string;
  fact: string;
  created_at: number;
}

function rowToFact(r: MemoryRow): MemoryFact {
  return { id: r.id, userUid: r.user_uid, fact: r.fact, createdAt: r.created_at };
}
