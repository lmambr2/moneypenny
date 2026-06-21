import type Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, type Dirent } from "node:fs";
import type { Logger } from "../logger.js";

export interface DoctrineDoc {
  source: string;
  classification: string;
  tags: string[];
  validUntil?: string;
  chunks: number;
  bytes: number;
  updatedAt: number;
}

/**
 * Registry + on-disk store for doctrine documents (ROADMAP Phase 6). The uploaded
 * `.md` files are the source of truth (kept in `<dataDir>/doctrine/`, so reindex
 * and delete have something to act on); a SQLite table tracks metadata for the
 * admin list/delete UI. Embedding into the vector store is handled separately by
 * the RetrievalStore — this just owns the corpus on disk + its registry.
 */
export class DoctrineStore {
  private db: Database.Database;
  readonly dir: string;
  private logger?: Logger;
  private upsertStmt: Database.Statement;
  private listStmt: Database.Statement;
  private getStmt: Database.Statement;
  private delStmt: Database.Statement;

  constructor(db: Database.Database, dataDir: string, logger?: Logger) {
    this.db = db;
    this.dir = path.join(dataDir, "doctrine");
    this.logger = logger;
    mkdirSync(this.dir, { recursive: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS doctrine_docs (
        source TEXT PRIMARY KEY,
        classification TEXT NOT NULL DEFAULT 'unclassified',
        tags TEXT NOT NULL DEFAULT '',
        valid_until TEXT,
        chunks INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    try {
      this.db.exec(`ALTER TABLE doctrine_docs ADD COLUMN valid_until TEXT`);
    } catch {
      /* column exists */
    }
    this.upsertStmt = this.db.prepare(
      `INSERT INTO doctrine_docs (source, classification, tags, valid_until, chunks, bytes, updated_at)
       VALUES (@source, @classification, @tags, @validUntil, @chunks, @bytes, @updatedAt)
       ON CONFLICT(source) DO UPDATE SET
         classification=excluded.classification, tags=excluded.tags,
         valid_until=excluded.valid_until,
         chunks=excluded.chunks, bytes=excluded.bytes, updated_at=excluded.updated_at`,
    );
    this.listStmt = this.db.prepare(`SELECT * FROM doctrine_docs ORDER BY source ASC`);
    this.getStmt = this.db.prepare(`SELECT * FROM doctrine_docs WHERE source = ?`);
    this.delStmt = this.db.prepare(`DELETE FROM doctrine_docs WHERE source = ?`);
  }

  /** Resolved doctrine root — prefix guard for all relative paths. */
  private rootDir(): string {
    return path.resolve(this.dir);
  }

  /**
   * Sanitize a doctrine source path (flat or nested, e.g. `intel/intsum.md`).
   * Rejects traversal and non-markdown names.
   */
  safeName(name: string): string | null {
    const raw = String(name || "").replace(/\\/g, "/").trim();
    if (!raw || !/\.(md|markdown)$/i.test(raw)) return null;
    const parts = raw.split("/").filter((p) => p && p !== ".");
    if (parts.length === 0 || parts.some((p) => p === "..")) return null;
    const rel = parts.join("/");
    const resolved = path.resolve(this.dir, rel);
    const root = this.rootDir();
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    return rel;
  }

  private filePath(source: string): string | null {
    const safe = this.safeName(source);
    return safe ? path.join(this.dir, safe) : null;
  }

  /** Write a doctrine file to disk. Returns the safe source name, or null if invalid. */
  saveFile(name: string, content: string): string | null {
    const source = this.safeName(name);
    const p = source ? this.filePath(source) : null;
    if (!source || !p) return null;
    mkdirSync(path.dirname(p), { recursive: true });
    // Skip no-op writes — reindex/ingest would otherwise bump mtime and re-fire
    // the doctrine dir watcher, starving ollama (embed + !ask chat).
    if (existsSync(p)) {
      try {
        if (readFileSync(p, "utf-8") === content) return source;
      } catch {
        // fall through to rewrite
      }
    }
    writeFileSync(p, content, "utf-8");
    return source;
  }

  readFile(source: string): string | null {
    const p = this.filePath(source);
    return p && existsSync(p) ? readFileSync(p, "utf-8") : null;
  }

  upsert(meta: DoctrineDoc): void {
    this.upsertStmt.run({ ...meta, tags: meta.tags.join(","), validUntil: meta.validUntil ?? null });
  }

  list(): DoctrineDoc[] {
    return (this.listStmt.all() as DoctrineRow[]).map(rowToDoc);
  }

  get(source: string): DoctrineDoc | null {
    const r = this.getStmt.get(source) as DoctrineRow | undefined;
    return r ? rowToDoc(r) : null;
  }

  /** Remove a doctrine doc's file + registry row. Returns true if anything was removed. */
  remove(source: string): boolean {
    const safe = this.safeName(source);
    const p = safe ? this.filePath(safe) : null;
    if (!safe || !p) return false;
    try { rmSync(p, { force: true }); } catch (err) { this.logger?.warn({ err, source }, "doctrine file delete failed"); }
    return this.delStmt.run(safe).changes > 0;
  }

  /** All `.md` files on disk, relative to the doctrine dir (reindex source of truth). */
  files(): string[] {
    const root = this.rootDir();
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(md|markdown)$/i.test(e.name)) {
          out.push(path.relative(root, full).split(path.sep).join("/"));
        }
      }
    };
    walk(root);
    return out.sort();
  }
}

interface DoctrineRow {
  source: string;
  classification: string;
  tags: string;
  valid_until?: string | null;
  chunks: number;
  bytes: number;
  updated_at: number;
}

function rowToDoc(r: DoctrineRow): DoctrineDoc {
  return {
    source: r.source,
    classification: r.classification,
    tags: r.tags ? String(r.tags).split(",").filter(Boolean) : [],
    validUntil: r.valid_until?.trim() || undefined,
    chunks: r.chunks,
    bytes: r.bytes,
    updatedAt: r.updated_at,
  };
}
