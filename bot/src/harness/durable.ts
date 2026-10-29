/**
 * SQLite harness_turns (PR-H2). Ring buffer stays the live dashboard.
 * user_text is user ASR or typed text — never Talker 0x02. PCM is not stored.
 */
import type Database from "better-sqlite3";

export const HARNESS_TURN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface DurableHarnessTurn {
  id: string;
  at: number;
  channel: string;
  conversationId?: string;
  userUid?: string;
  mode: string;
  userText: string;
  replyText: string;
  toolsJson: string;
  sourcesJson: string;
  error?: string;
  steps: number;
}

export class DurableHarnessStore {
  private insertStmt: Database.Statement;
  private pruneStmt: Database.Statement;
  private listStmt: Database.Statement;

  constructor(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS harness_turns (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        channel TEXT NOT NULL,
        conversation_id TEXT,
        user_uid TEXT,
        mode TEXT NOT NULL,
        user_text TEXT NOT NULL,
        reply_text TEXT NOT NULL,
        tools_json TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        error TEXT,
        steps INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_harness_turns_at ON harness_turns(at);
    `);
    this.insertStmt = db.prepare(`
      INSERT OR REPLACE INTO harness_turns (
        id, at, channel, conversation_id, user_uid, mode,
        user_text, reply_text, tools_json, sources_json, error, steps
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.pruneStmt = db.prepare(`DELETE FROM harness_turns WHERE at < ?`);
    this.listStmt = db.prepare(`SELECT * FROM harness_turns ORDER BY at DESC, id DESC LIMIT ?`);
  }

  insert(turn: DurableHarnessTurn, now = Date.now()): void {
    this.pruneStmt.run(now - HARNESS_TURN_RETENTION_MS);
    this.insertStmt.run(
      turn.id,
      turn.at,
      turn.channel,
      turn.conversationId ?? null,
      turn.userUid ?? null,
      turn.mode,
      turn.userText,
      turn.replyText,
      turn.toolsJson,
      turn.sourcesJson,
      turn.error ?? null,
      turn.steps,
    );
  }

  list(limit = 30): DurableHarnessTurn[] {
    const rows = this.listStmt.all(Math.max(1, limit)) as Array<{
      id: string;
      at: number;
      channel: string;
      conversation_id: string | null;
      user_uid: string | null;
      mode: string;
      user_text: string;
      reply_text: string;
      tools_json: string;
      sources_json: string;
      error: string | null;
      steps: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      channel: r.channel,
      conversationId: r.conversation_id ?? undefined,
      userUid: r.user_uid ?? undefined,
      mode: r.mode,
      userText: r.user_text,
      replyText: r.reply_text,
      toolsJson: r.tools_json,
      sourcesJson: r.sources_json,
      error: r.error ?? undefined,
      steps: r.steps,
    }));
  }
}
