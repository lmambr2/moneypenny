import type Database from "better-sqlite3";

export type FileDropKind = "doctrine" | "music" | "skipped";

export interface IngestedFile {
  key: string;
  name: string;
  kind: FileDropKind;
  result: string;
}

export interface RecentIngest extends IngestedFile {
  ingestedAt: number;
}

/**
 * Seen-set for TeamSpeak file-browser ingestion (ROADMAP Phase 6, TS-native
 * path). Records every channel file the drop watcher has already processed so a
 * file is ingested exactly once — including across bot restarts (hence SQLite,
 * not an in-memory Set). The key encodes channel + name + size + mtime, so a
 * re-uploaded or edited file (new size/mtime) is treated as new and re-ingests.
 */
export class FileDropStore {
  private seenStmt: Database.Statement;
  private recordStmt: Database.Statement;
  private recentStmt: Database.Statement;

  constructor(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ingested_files (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        result TEXT NOT NULL DEFAULT '',
        ingested_at INTEGER NOT NULL
      );
    `);
    this.seenStmt = db.prepare(`SELECT 1 FROM ingested_files WHERE key = ?`);
    this.recentStmt = db.prepare(
      `SELECT key, name, kind, result, ingested_at FROM ingested_files
       ORDER BY ingested_at DESC LIMIT ?`,
    );
    this.recordStmt = db.prepare(
      `INSERT INTO ingested_files (key, name, kind, result, ingested_at)
       VALUES (@key, @name, @kind, @result, @ingestedAt)
       ON CONFLICT(key) DO UPDATE SET
         name=excluded.name, kind=excluded.kind, result=excluded.result,
         ingested_at=excluded.ingested_at`,
    );
  }

  seen(key: string): boolean {
    return this.seenStmt.get(key) != null;
  }

  record(entry: IngestedFile): void {
    this.recordStmt.run({ ...entry, ingestedAt: Date.now() });
  }

  /** Most-recent ingest-log entries (newest first), for the `!ingeststatus` command. */
  recent(limit = 10): RecentIngest[] {
    return (this.recentStmt.all(limit) as IngestedFileRow[]).map((r) => ({
      key: r.key,
      name: r.name,
      kind: r.kind as FileDropKind,
      result: r.result,
      ingestedAt: r.ingested_at,
    }));
  }
}

interface IngestedFileRow {
  key: string;
  name: string;
  kind: string;
  result: string;
  ingested_at: number;
}
