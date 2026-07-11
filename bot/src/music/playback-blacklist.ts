/**
 * Playback blacklist — admin-curated track IDs that must never reach the
 * channel (search pick, radio seed, resolveAndPlay). Independent of TagStore
 * bumper flags: blacklisted library tracks still appear in the Library UI so
 * admins can unban them; they are only blocked from playback paths.
 */
import type Database from "better-sqlite3";
import { extractVideoId } from "./youtube.js";

export interface BlacklistEntry {
  trackKey: string;
  platform: string | null;
  name: string | null;
  artist: string | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: number;
}

export interface PlaybackBlacklistOptions {
  db: Database.Database;
  now?: () => number;
}

export class PlaybackBlacklist {
  private db: Database.Database;
  private nowFn: () => number;
  private insertStmt: Database.Statement;
  private deleteStmt: Database.Statement;
  private hasStmt: Database.Statement;
  private listStmt: Database.Statement;

  constructor(opts: PlaybackBlacklistOptions) {
    this.db = opts.db;
    this.nowFn = opts.now ?? Date.now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS playback_blacklist (
        track_key TEXT PRIMARY KEY,
        platform TEXT,
        name TEXT,
        artist TEXT,
        reason TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    this.insertStmt = this.db.prepare(
      `INSERT INTO playback_blacklist (track_key, platform, name, artist, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(track_key) DO UPDATE SET
         platform = COALESCE(excluded.platform, playback_blacklist.platform),
         name = COALESCE(excluded.name, playback_blacklist.name),
         artist = COALESCE(excluded.artist, playback_blacklist.artist),
         reason = COALESCE(excluded.reason, playback_blacklist.reason),
         created_by = COALESCE(excluded.created_by, playback_blacklist.created_by),
         created_at = excluded.created_at`,
    );
    this.deleteStmt = this.db.prepare(`DELETE FROM playback_blacklist WHERE track_key = ?`);
    this.hasStmt = this.db.prepare(
      `SELECT 1 AS ok FROM playback_blacklist WHERE track_key = ? LIMIT 1`,
    );
    this.listStmt = this.db.prepare(
      `SELECT track_key, platform, name, artist, reason, created_by, created_at
       FROM playback_blacklist ORDER BY created_at DESC`,
    );
  }

  add(entry: {
    trackKey: string;
    platform?: string | null;
    name?: string | null;
    artist?: string | null;
    reason?: string | null;
    createdBy?: string | null;
  }): BlacklistEntry {
    const trackKey = entry.trackKey.trim();
    if (!trackKey) throw Object.assign(new Error("trackKey required"), { code: "VALIDATION" });
    const createdAt = this.nowFn();
    this.insertStmt.run(
      trackKey,
      entry.platform ?? null,
      entry.name ?? null,
      entry.artist ?? null,
      entry.reason ?? null,
      entry.createdBy ?? null,
      createdAt,
    );
    // Also index bare YouTube video ids when the key is a full URL form.
    const vid = extractVideoId(trackKey);
    if (vid && vid !== trackKey) {
      this.insertStmt.run(
        vid,
        entry.platform ?? "youtube",
        entry.name ?? null,
        entry.artist ?? null,
        entry.reason ?? null,
        entry.createdBy ?? null,
        createdAt,
      );
    }
    return {
      trackKey,
      platform: entry.platform ?? null,
      name: entry.name ?? null,
      artist: entry.artist ?? null,
      reason: entry.reason ?? null,
      createdBy: entry.createdBy ?? null,
      createdAt,
    };
  }

  remove(trackKey: string): boolean {
    const key = trackKey.trim();
    if (!key) return false;
    let removed = this.deleteStmt.run(key).changes > 0;
    const vid = extractVideoId(key);
    if (vid && vid !== key) {
      removed = this.deleteStmt.run(vid).changes > 0 || removed;
    }
    return removed;
  }

  /** Exact key presence (one DB lookup). */
  hasKey(trackKey: string): boolean {
    if (!trackKey) return false;
    return !!this.hasStmt.get(trackKey);
  }

  /**
   * True when this song (or its YouTube video id) is blacklisted.
   * Checks both the opaque id and any extractable YT id so local YT saves
   * blacklisted by video id still block.
   */
  isBlacklisted(song: { id?: string | null; name?: string | null } | null | undefined): boolean {
    if (!song?.id) return false;
    if (this.hasKey(song.id)) return true;
    const vid = extractVideoId(song.id);
    if (vid && vid !== song.id && this.hasKey(vid)) return true;
    // Local YT save: basename often embeds [videoId] in the display name.
    const name = song.name ?? "";
    const m = name.match(/\[([A-Za-z0-9_-]{11})\]/);
    if (m?.[1] && this.hasKey(m[1])) return true;
    return false;
  }

  keySet(): Set<string> {
    const rows = this.listStmt.all() as { track_key: string }[];
    return new Set(rows.map((r) => r.track_key));
  }

  list(): BlacklistEntry[] {
    const rows = this.listStmt.all() as {
      track_key: string;
      platform: string | null;
      name: string | null;
      artist: string | null;
      reason: string | null;
      created_by: string | null;
      created_at: number;
    }[];
    return rows.map((r) => ({
      trackKey: r.track_key,
      platform: r.platform,
      name: r.name,
      artist: r.artist,
      reason: r.reason,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
  }
}

/** Filter helper for search/seed pipelines. */
export function filterNotBlacklisted<T extends { id?: string | null; name?: string | null }>(
  songs: T[],
  blacklist: PlaybackBlacklist | null | undefined,
): T[] {
  if (!blacklist) return songs;
  return songs.filter((s) => !blacklist.isBlacklisted(s));
}

export function blacklistedMessage(song: { name?: string; artist?: string }): string {
  const label = [song.name, song.artist].filter(Boolean).join(" — ") || "that track";
  return `Blocked by station blacklist: ${label}`;
}
