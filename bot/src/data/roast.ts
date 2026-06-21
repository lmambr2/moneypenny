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

const META_LAST_ROAST_AT = "last_roast_at";

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
  private metaGetStmt: Database.Statement;
  private metaSetStmt: Database.Statement;
  private countGradedStmt: Database.Statement;
  private countUngradedStmt: Database.Statement;
  private recentDupStmt: Database.Statement;
  private removeIdsStmt: Database.Statement;

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
      CREATE TABLE IF NOT EXISTS roast_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
    this.metaGetStmt = db.prepare(`SELECT value FROM roast_meta WHERE key = ?`);
    this.metaSetStmt = db.prepare(
      `INSERT INTO roast_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    this.countGradedStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM roast_quotes WHERE score IS NOT NULL AND score >= ?`,
    );
    this.countUngradedStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM roast_quotes WHERE score IS NULL`,
    );
    this.recentDupStmt = db.prepare(
      `SELECT 1 FROM roast_quotes WHERE user_uid = ? AND text = ? AND created_at > ? LIMIT 1`,
    );
    this.removeIdsStmt = db.prepare(`DELETE FROM roast_quotes WHERE id = ?`);
  }

  /** Record one captured line. Callers must check {@link isOptedOut} first. */
  add(userUid: string, userName: string, text: string): void {
    this.addStmt.run(userUid, userName, text, Date.now());
  }

  /** Skip near-duplicate lines from the same user (spam / echo). */
  hasRecentDuplicate(userUid: string, text: string, withinMs: number): boolean {
    const since = Date.now() - withinMs;
    return !!this.recentDupStmt.get(userUid, text, since);
  }

  /** Oldest ungraded lines, for a batched grading pass. */
  ungraded(limit = 25): RoastQuote[] {
    return (this.ungradedStmt.all(limit) as unknown[]).map(rowToQuote);
  }

  ungradedCount(): number {
    return (this.countUngradedStmt.get() as { n: number }).n;
  }

  setGrade(id: number, score: number, reason: string): void {
    this.gradeStmt.run(clampScore(score), reason.slice(0, 280), id);
  }

  /** Highest-graded lines for the compilation. */
  top(limit = 8): RoastQuote[] {
    return (this.topStmt.all(limit) as unknown[]).map(rowToQuote);
  }

  gradedCount(minScore = 0): number {
    return (this.countGradedStmt.get(minScore) as { n: number }).n;
  }

  getLastRoastAt(): number {
    const row = this.metaGetStmt.get(META_LAST_ROAST_AT) as { value: string } | undefined;
    if (!row?.value) return 0;
    const n = Number(row.value);
    return Number.isFinite(n) ? n : 0;
  }

  setLastRoastAt(ts: number): void {
    this.metaSetStmt.run(META_LAST_ROAST_AT, String(ts));
  }

  removeByIds(ids: number[]): void {
    for (const id of ids) this.removeIdsStmt.run(id);
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