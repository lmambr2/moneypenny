/**
 * Persistent economy API cache — SQLite L2 (key → JSON blob + TTL).
 *
 * Policy:
 *  - Exact key lookup (uex/commodities, sc-craft search:…, etc.)
 *  - Stale rows remain readable (fail-open / SWR)
 *  - Optional one-shot import of legacy JSON files under dataDir/economy-cache/
 *  - Cap row count; drop oldest by fetched_at
 *
 * Backends:
 *  - Shared bot `Database` (default at boot) — table `economy_cache`
 *  - Standalone file `…/economy-cache.db` or `:memory:` (tests)
 *  - Directory path → opens `{dir}/economy-cache.db` + migrates JSON in that dir
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

export type EconomyCacheSource = "uex" | "sc-craft" | "sc-trade" | "sc-wiki" | "meta";

export interface EconomyCacheRecord<T = unknown> {
  source: EconomyCacheSource;
  key: string;
  fetchedAt: number;
  expiresAt: number;
  data: T;
}

export interface EconomyCacheHit<T> {
  data: T;
  fetchedAt: number;
  expiresAt: number;
  /** True when past expiresAt but still stored (usable offline / SWR). */
  stale: boolean;
}

export interface EconomyCacheStats {
  /** Human label: sqlite path or "sqlite:shared". */
  root: string;
  backend: "sqlite";
  sources: Array<{
    source: string;
    files: number;
    bytes: number;
    fresh: number;
    stale: number;
  }>;
  totalFiles: number;
  totalBytes: number;
}

/** Soft cap — oldest rows pruned after set. Override via ECONOMY_CACHE_MAX_ROWS. */
const DEFAULT_MAX_ROWS = 2_000;

const SOURCES: EconomyCacheSource[] = ["uex", "sc-craft", "sc-trade", "sc-wiki", "meta"];

function maxRows(): number {
  const n = parseInt(process.env.ECONOMY_CACHE_MAX_ROWS || "", 10);
  return Number.isFinite(n) && n > 50 ? n : DEFAULT_MAX_ROWS;
}

export class EconomyDiskCache {
  readonly root: string;
  private db: Database.Database;
  private ownsDb: boolean;
  private getStmt!: Database.Statement;
  private setStmt!: Database.Statement;
  private delStmt!: Database.Statement;
  private clearAllStmt!: Database.Statement;
  private clearSourceStmt!: Database.Statement;
  private countStmt!: Database.Statement;
  private pruneStmt!: Database.Statement;
  private statsStmt!: Database.Statement;

  /**
   * @param rootOrDb Directory (→ `{dir}/economy-cache.db` + JSON migrate),
   *   `.db` path, `:memory:`, or an open better-sqlite3 Database.
   */
  constructor(rootOrDb: string | Database.Database) {
    let legacyMigrateDir: string | null = null;

    if (typeof rootOrDb !== "string") {
      this.db = rootOrDb;
      this.root = "sqlite:shared";
      this.ownsDb = false;
    } else if (
      rootOrDb === ":memory:" ||
      rootOrDb.endsWith(".db") ||
      rootOrDb.endsWith(".sqlite")
    ) {
      try {
        if (rootOrDb !== ":memory:") mkdirSync(dirname(rootOrDb), { recursive: true });
      } catch {
        /* ignore */
      }
      this.db = new Database(rootOrDb);
      this.root = rootOrDb === ":memory:" ? "sqlite:memory" : rootOrDb;
      this.ownsDb = true;
    } else {
      try {
        mkdirSync(rootOrDb, { recursive: true });
      } catch {
        /* ignore */
      }
      const dbPath = join(rootOrDb, "economy-cache.db");
      this.db = new Database(dbPath);
      this.root = dbPath;
      this.ownsDb = true;
      legacyMigrateDir = rootOrDb;
    }

    this.initSchema();
    this.bindStatements();
    if (legacyMigrateDir) this.migrateLegacyJsonDir(legacyMigrateDir);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS economy_cache (
        source TEXT NOT NULL,
        key TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (source, key)
      );
      CREATE INDEX IF NOT EXISTS idx_economy_cache_exp ON economy_cache(expires_at);
      CREATE INDEX IF NOT EXISTS idx_economy_cache_fetched ON economy_cache(fetched_at);
    `);
  }

  private bindStatements(): void {
    this.getStmt = this.db.prepare(
      `SELECT source, key, fetched_at, expires_at, data FROM economy_cache WHERE source = ? AND key = ?`,
    );
    this.setStmt = this.db.prepare(
      `INSERT INTO economy_cache (source, key, fetched_at, expires_at, bytes, data)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, key) DO UPDATE SET
         fetched_at = excluded.fetched_at,
         expires_at = excluded.expires_at,
         bytes = excluded.bytes,
         data = excluded.data`,
    );
    this.delStmt = this.db.prepare(`DELETE FROM economy_cache WHERE source = ? AND key = ?`);
    this.clearAllStmt = this.db.prepare(`DELETE FROM economy_cache`);
    this.clearSourceStmt = this.db.prepare(`DELETE FROM economy_cache WHERE source = ?`);
    this.countStmt = this.db.prepare(`SELECT COUNT(*) AS n FROM economy_cache`);
    this.pruneStmt = this.db.prepare(
      `DELETE FROM economy_cache WHERE rowid IN (
         SELECT rowid FROM economy_cache ORDER BY fetched_at ASC LIMIT ?
       )`,
    );
    this.statsStmt = this.db.prepare(
      `SELECT source,
              COUNT(*) AS files,
              COALESCE(SUM(bytes), 0) AS bytes,
              SUM(CASE WHEN expires_at >= ? THEN 1 ELSE 0 END) AS fresh,
              SUM(CASE WHEN expires_at < ? THEN 1 ELSE 0 END) AS stale
       FROM economy_cache
       GROUP BY source`,
    );
  }

  /** Import legacy JSON files under a directory (idempotent). */
  migrateLegacyJsonDir(dir: string): number {
    if (!existsSync(dir)) return 0;
    let imported = 0;
    for (const source of SOURCES) {
      const sdir = join(dir, source);
      if (!existsSync(sdir)) continue;
      let files: string[];
      try {
        files = readdirSync(sdir).filter((f) => f.endsWith(".json"));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const raw = readFileSync(join(sdir, f), "utf-8");
          const rec = JSON.parse(raw) as EconomyCacheRecord;
          if (!rec?.source || rec.data === undefined || typeof rec.key !== "string") continue;
          const src = rec.source as EconomyCacheSource;
          if (!SOURCES.includes(src)) continue;
          const existing = this.get(src, rec.key);
          // Keep SQLite row if it is fresher or equal
          if (existing && existing.fetchedAt >= (rec.fetchedAt ?? 0)) continue;
          const fetchedAt = rec.fetchedAt ?? Date.now();
          const expiresAt = rec.expiresAt ?? fetchedAt + 6 * 3600_000;
          const payload = JSON.stringify(rec.data);
          this.setStmt.run(
            src,
            rec.key,
            fetchedAt,
            expiresAt,
            Buffer.byteLength(payload, "utf-8"),
            payload,
          );
          imported += 1;
        } catch {
          /* skip bad file */
        }
      }
    }
    if (imported > 0) this.pruneIfNeeded();
    return imported;
  }

  /** Test / ops: remove legacy JSON files after successful migrate. */
  static wipeLegacyJsonDir(dir: string): number {
    let n = 0;
    for (const source of SOURCES) {
      const sdir = join(dir, source);
      if (!existsSync(sdir)) continue;
      for (const f of readdirSync(sdir)) {
        if (!f.endsWith(".json")) continue;
        try {
          rmSync(join(sdir, f), { force: true });
          n += 1;
        } catch {
          /* ignore */
        }
      }
    }
    return n;
  }

  pathFor(source: EconomyCacheSource, key: string): string {
    return `sqlite://${this.root}#${source}/${key}`;
  }

  get<T>(source: EconomyCacheSource, key: string, now = Date.now()): EconomyCacheHit<T> | null {
    try {
      const row = this.getStmt.get(source, key) as
        | {
            source: string;
            key: string;
            fetched_at: number;
            expires_at: number;
            data: string;
          }
        | undefined;
      if (!row) return null;
      const data = JSON.parse(row.data) as T;
      return {
        data,
        fetchedAt: row.fetched_at,
        expiresAt: row.expires_at,
        stale: now > row.expires_at,
      };
    } catch {
      return null;
    }
  }

  getFresh<T>(source: EconomyCacheSource, key: string, now = Date.now()): T | null {
    const hit = this.get<T>(source, key, now);
    if (!hit || hit.stale) return null;
    return hit.data;
  }

  set<T>(source: EconomyCacheSource, key: string, data: T, ttlMs: number, now = Date.now()): void {
    try {
      const payload = JSON.stringify(data);
      const bytes = Buffer.byteLength(payload, "utf-8");
      this.setStmt.run(source, key, now, now + Math.max(0, ttlMs), bytes, payload);
      this.pruneIfNeeded();
    } catch {
      // Disk full / locked — memory clients still work.
    }
  }

  private pruneIfNeeded(): void {
    try {
      const row = this.countStmt.get() as { n: number };
      const over = (row?.n ?? 0) - maxRows();
      if (over > 0) this.pruneStmt.run(over);
    } catch {
      /* ignore */
    }
  }

  delete(source: EconomyCacheSource, key: string): boolean {
    try {
      return this.delStmt.run(source, key).changes > 0;
    } catch {
      return false;
    }
  }

  clear(source?: EconomyCacheSource): number {
    try {
      if (source) return this.clearSourceStmt.run(source).changes;
      return this.clearAllStmt.run().changes;
    } catch {
      return 0;
    }
  }

  stats(now = Date.now()): EconomyCacheStats {
    const bySource = new Map<
      string,
      { files: number; bytes: number; fresh: number; stale: number }
    >();
    for (const s of SOURCES) {
      bySource.set(s, { files: 0, bytes: 0, fresh: 0, stale: 0 });
    }
    try {
      const rows = this.statsStmt.all(now, now) as Array<{
        source: string;
        files: number;
        bytes: number;
        fresh: number;
        stale: number;
      }>;
      for (const r of rows) {
        bySource.set(r.source, {
          files: Number(r.files) || 0,
          bytes: Number(r.bytes) || 0,
          fresh: Number(r.fresh) || 0,
          stale: Number(r.stale) || 0,
        });
      }
    } catch {
      /* empty */
    }
    const sources = SOURCES.map((source) => {
      const s = bySource.get(source)!;
      return { source, ...s };
    });
    return {
      root: this.root,
      backend: "sqlite",
      sources,
      totalFiles: sources.reduce((a, s) => a + s.files, 0),
      totalBytes: sources.reduce((a, s) => a + s.bytes, 0),
    };
  }

  close(): void {
    if (this.ownsDb) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let defaultCache: EconomyDiskCache | null = null;
let defaultRoot: string | null = null;

/** Legacy JSON directory (for one-shot migrate). */
export function resolveEconomyCacheRoot(dataDir?: string): string {
  const env = (process.env.ECONOMY_CACHE_DIR || "").trim();
  if (env) return env;
  if (dataDir) return join(dataDir, "economy-cache");
  try {
    const candidate = join(process.cwd(), "data", "economy-cache");
    mkdirSync(candidate, { recursive: true });
    return candidate;
  } catch {
    return join(tmpdir(), "moneypenny-economy-cache");
  }
}

export function resolveEconomyCacheDbPath(dataDir?: string): string {
  const env = (process.env.ECONOMY_CACHE_DB || "").trim();
  if (env) return env;
  const root = resolveEconomyCacheRoot(dataDir);
  return join(root, "economy-cache.db");
}

export interface InitEconomyCacheOpts {
  /** Prefer sharing the main bot SQLite (recommended). */
  db?: Database.Database;
  dataDir?: string;
  /** Import legacy JSON once from this dir (default: dataDir/economy-cache). */
  legacyJsonDir?: string;
}

/**
 * Init process-global economy L2 cache.
 * - With `db`: table lives in main moneypenny.db
 * - Else: dedicated `economy-cache.db` under dataDir
 */
export function initEconomyDiskCache(
  dataDirOrOpts?: string | InitEconomyCacheOpts,
): EconomyDiskCache {
  const opts: InitEconomyCacheOpts =
    typeof dataDirOrOpts === "string" || dataDirOrOpts === undefined
      ? { dataDir: dataDirOrOpts }
      : dataDirOrOpts;

  const legacyDir =
    opts.legacyJsonDir ??
    (opts.dataDir ? join(opts.dataDir, "economy-cache") : resolveEconomyCacheRoot());

  let cache: EconomyDiskCache;
  let rootKey: string;

  if (opts.db) {
    rootKey = "sqlite:shared";
    if (defaultCache && defaultRoot === rootKey) return defaultCache;
    cache = new EconomyDiskCache(opts.db);
  } else {
    const dbPath = resolveEconomyCacheDbPath(opts.dataDir);
    rootKey = dbPath;
    if (defaultCache && defaultRoot === rootKey) return defaultCache;
    cache = new EconomyDiskCache(dbPath);
  }

  try {
    if (existsSync(legacyDir)) {
      cache.migrateLegacyJsonDir(legacyDir);
    }
  } catch {
    /* ignore migrate errors */
  }

  defaultCache = cache;
  defaultRoot = rootKey;
  return cache;
}

export function getEconomyDiskCache(): EconomyDiskCache {
  if (!defaultCache) return initEconomyDiskCache();
  return defaultCache;
}

/** Test helper. */
export function setEconomyDiskCacheForTests(cache: EconomyDiskCache | null): void {
  defaultCache = cache;
  defaultRoot = cache?.root ?? null;
}
