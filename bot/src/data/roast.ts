import type Database from "better-sqlite3";

export interface RoastQuote {
  id: number;
  userUid: string;
  userName: string;
  text: string;
  createdAt: number;
  /** LLM cringe score 0–10; null = not yet graded. */
  score: number | null;
  reason: string | null;
}

/**
 * Storage for the "roast" feature (ROADMAP Phase 8): capture each member's chat
 * lines → LLM cringe-grade (0–10 + one-line reason) → compile a greatest-hits
 * reel when enough people are present. Opting out purges a user's lines and
 * blocks further capture. Backed by the bot's existing SQLite db, so the MVP
 * needs no new infrastructure (the vector-DB/MemPalace upgrades come later).
 */
export class RoastStore {
  private addStmt: Database.Statement;
  private ungradedStmt: Database.Statement;
  private gradeStmt: Database.Statement;
  private topStmt: Database.Statement;
  private optInStmt: Database.Statement;
  private isOptedStmt: Database.Statement;
  private purgeStmt: Database.Statement;

  constructor(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS roast_quotes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_uid TEXT NOT NULL,
        user_name TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        score INTEGER,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_roast_quotes_score ON roast_quotes(score);
      CREATE TABLE IF NOT EXISTS roast_optout (
        user_uid TEXT PRIMARY KEY
      );
    `);
    this.addStmt = db.prepare(
      `INSERT INTO roast_quotes (user_uid, user_name, text, created_at) VALUES (?, ?, ?, ?)`,
    );
    this.ungradedStmt = db.prepare(
      `SELECT * FROM roast_quotes WHERE score IS NULL ORDER BY created_at ASC LIMIT ?`,
    );
    this.gradeStmt = db.prepare(`UPDATE roast_quotes SET score = ?, reason = ? WHERE id = ?`);
    this.topStmt = db.prepare(
      `SELECT * FROM roast_quotes WHERE score IS NOT NULL ORDER BY score DESC, created_at DESC LIMIT ?`,
    );
    this.optInStmt = db.prepare(`INSERT OR IGNORE INTO roast_optout (user_uid) VALUES (?)`);
    this.isOptedStmt = db.prepare(`SELECT 1 FROM roast_optout WHERE user_uid = ?`);
    this.purgeStmt = db.prepare(`DELETE FROM roast_quotes WHERE user_uid = ?`);
  }

  /** Record one captured line. Callers must check {@link isOptedOut} first. */
  add(userUid: string, userName: string, text: string): void {
    this.addStmt.run(userUid, userName, text, Date.now());
  }

  /** Oldest ungraded lines, for a batched grading pass. */
  ungraded(limit = 25): RoastQuote[] {
    return (this.ungradedStmt.all(limit) as unknown[]).map(rowToQuote);
  }

  setGrade(id: number, score: number, reason: string): void {
    this.gradeStmt.run(clampScore(score), reason.slice(0, 280), id);
  }

  /** Highest-graded lines for the compilation. */
  top(limit = 8): RoastQuote[] {
    return (this.topStmt.all(limit) as unknown[]).map(rowToQuote);
  }

  isOptedOut(userUid: string): boolean {
    return !!this.isOptedStmt.get(userUid);
  }

  /** Opt a user out of the roast and purge everything they've said. Returns rows removed. */
  optOut(userUid: string): number {
    this.optInStmt.run(userUid);
    return this.purgeStmt.run(userUid).changes;
  }
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, Math.round(n)));
}

function rowToQuote(r: any): RoastQuote {
  return {
    id: r.id,
    userUid: r.user_uid,
    userName: r.user_name,
    text: r.text,
    createdAt: r.created_at,
    score: r.score ?? null,
    reason: r.reason ?? null,
  };
}
