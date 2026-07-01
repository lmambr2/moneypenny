/**
 * BumperCache — persistence for generated (TTS) bumpers (docs/radio.md §6.5).
 * Generated bumpers are NOT added to the music library; they live in a dedicated
 * cache dir + index table so repeated station IDs/liners skip the NPU+TTS cost
 * and we keep an audit trail of what was broadcast.
 *
 * Security rule (§6.5): only `unclassified`-floor bumpers are cacheable — a
 * cached file can be replayed to anyone, so caching a higher-clearance render
 * would be a classified-leak vector. `put()` refuses anything else.
 */
import type Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../logger.js";

export interface BumperCacheEntry {
  path: string;
  text: string;
  source: string;
}

export interface BumperCacheOptions {
  db: Database.Database;
  /** Directory for cached audio files (created if missing). */
  cacheDir: string;
  logger?: Logger;
  now?: () => number;
  /** LRU cap; oldest-touched entries are evicted past this. Default 200. */
  maxEntries?: number;
  /** Entries older than this (ms) are pruned. Default 30 days. */
  ttlMs?: number;
}

const DEFAULT_MAX = 200;
const DEFAULT_TTL_MS = 30 * 24 * 3600_000;

export class BumperCache {
  private db: Database.Database;
  private dir: string;
  private logger?: Logger;
  private nowFn: () => number;
  private maxEntries: number;
  private ttlMs: number;

  constructor(opts: BumperCacheOptions) {
    this.db = opts.db;
    this.dir = opts.cacheDir;
    this.logger = opts.logger;
    this.nowFn = opts.now ?? Date.now;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

    mkdirSync(this.dir, { recursive: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bumper_cache (
        hash TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        built_floor TEXT NOT NULL,
        voice TEXT,
        format TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        last_hit_at INTEGER NOT NULL
      );
    `);
  }

  /** Return a cached bumper for this key, bumping its hit count, or null. A row
   *  whose file has vanished is treated as a miss and cleaned up. */
  get(hash: string): BumperCacheEntry | null {
    const row = this.db
      .prepare(`SELECT path, text, source FROM bumper_cache WHERE hash = ?`)
      .get(hash) as { path: string; text: string; source: string } | undefined;
    if (!row) return null;
    if (!existsSync(row.path)) {
      this.db.prepare(`DELETE FROM bumper_cache WHERE hash = ?`).run(hash);
      return null;
    }
    const now = this.nowFn();
    this.db.prepare(`UPDATE bumper_cache SET hits = hits + 1, last_hit_at = ? WHERE hash = ?`).run(now, hash);
    return { path: row.path, text: row.text, source: row.source };
  }

  /**
   * Write a rendered bumper into the cache and return its path. Refuses any
   * non-`unclassified` floor (§6.5) — returns null so the caller plays the
   * fresh render without persisting it.
   */
  put(
    hash: string,
    audio: Buffer,
    format: string,
    meta: { text: string; source: string; voice?: string; builtFloor?: string },
  ): string | null {
    const floor = meta.builtFloor ?? "unclassified";
    if (floor !== "unclassified") {
      this.logger?.debug({ source: meta.source, floor }, "bumper cache: refusing non-unclassified entry");
      return null;
    }
    const ext = format.replace(/[^a-z0-9]/gi, "").toLowerCase() || "wav";
    const path = join(this.dir, `${hash}.${ext}`);
    try {
      writeFileSync(path, audio);
    } catch (err) {
      this.logger?.warn({ err, path }, "bumper cache: write failed");
      return null;
    }
    const now = this.nowFn();
    this.db
      .prepare(
        `INSERT INTO bumper_cache (hash, path, text, source, built_floor, voice, format, created_at, hits, last_hit_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(hash) DO UPDATE SET path = excluded.path, created_at = excluded.created_at, last_hit_at = excluded.last_hit_at`,
      )
      .run(hash, path, meta.text, meta.source, floor, meta.voice ?? null, ext, now, now);
    this.prune();
    return path;
  }

  /** Evict expired entries and enforce the LRU cap, deleting files too. */
  prune(): void {
    const now = this.nowFn();
    const expired = this.db
      .prepare(`SELECT hash, path FROM bumper_cache WHERE created_at < ?`)
      .all(now - this.ttlMs) as { hash: string; path: string }[];
    for (const e of expired) this.remove(e.hash, e.path);

    const overflow = this.db
      .prepare(
        `SELECT hash, path FROM bumper_cache ORDER BY last_hit_at DESC LIMIT -1 OFFSET ?`,
      )
      .all(this.maxEntries) as { hash: string; path: string }[];
    for (const e of overflow) this.remove(e.hash, e.path);
  }

  private remove(hash: string, path: string): void {
    try {
      rmSync(path, { force: true });
    } catch {
      /* ignore */
    }
    this.db.prepare(`DELETE FROM bumper_cache WHERE hash = ?`).run(hash);
  }
}
