/**
 * Playback blacklist — admin-curated track IDs that must never reach the
 * channel (search pick, radio seed, resolveAndPlay). Independent of TagStore
 * bumper flags: blacklisted library tracks still appear in the Library UI so
 * admins can unban them; they are only blocked from playback paths.
 *
 * Matching is multi-key: opaque id, YouTube video id, and a normalized
 * name+artist fingerprint so banning a local file also blocks the YouTube
 * re-seed of the same track (auto-DJ's common failure mode).
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

/** Content keys are stored with this prefix so they never collide with hash ids. */
export const CONTENT_KEY_PREFIX = "content:";

/**
 * Normalize a title/artist for fingerprint matching.
 * Strips punctuation and common "(Official Video)" noise so local vs YT titles align.
 */
export function normalizeBlacklistText(raw: string | null | undefined): string {
  if (!raw) return "";
  return (
    String(raw)
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\(official[^)]*\)/gi, " ")
      .replace(/\[official[^\]]*\]/gi, " ")
      .replace(/\bofficial\s+(hd\s+)?(music\s+)?video\b/gi, " ")
      .replace(/\bofficial\s+audio\b/gi, " ")
      .replace(/\bofficial\s+lyric\s+video\b/gi, " ")
      .replace(/\b(lyrics?|visualizer|remaster(ed)?|hq|hd|4k)\b/gi, " ")
      .replace(/\[[A-Za-z0-9_-]{11}\]/g, " ") // strip embedded [videoId]
      // "Bullsh*t" → "bullshit" (don't turn * into a word break or we miss YT titles)
      .replace(/\*/g, "")
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Stable content fingerprint for a track. Used as a secondary blacklist key so
 * the same song banned as a local hash still blocks the YouTube id re-seed.
 * Strips a leading "Artist " prefix when the title was stored as "Artist - Song".
 */
/** Artist channel noise ("Rick Beato - Topic", "X VEVO") so local/YT agree. */
export function normalizeBlacklistArtist(raw: string | null | undefined): string {
  return normalizeBlacklistText(raw)
    .replace(/\b(official|topic|vevo|records|music|channel|auto[\s-]?generated)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Collapse vowel differences so censored titles still match:
 * "Bullsh*t" → "bullsht", "Bullshit" → "bullshit" → both → "bllsht".
 */
function collapseForFingerprint(s: string): string {
  return s.replace(/[aeiouy]/g, "");
}

export function blacklistContentKey(
  name: string | null | undefined,
  artist?: string | null,
): string | null {
  let n = normalizeBlacklistText(name);
  if (n.length < 3) return null;
  const a = normalizeBlacklistArtist(artist);
  // "Icewear Vezzo - Heavy Metal" + artist Icewear Vezzo → "heavy metal"
  if (a && n.startsWith(`${a} `)) {
    n = n.slice(a.length).trim();
  }
  if (n.length < 3) return null;
  const nKey = collapseForFingerprint(n);
  const aKey = a ? collapseForFingerprint(a) : "";
  if (nKey.length < 3) return null;
  return aKey ? `${CONTENT_KEY_PREFIX}${nKey}|${aKey}` : `${CONTENT_KEY_PREFIX}${nKey}`;
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
    // One-shot: ensure existing bans also have content fingerprints.
    this.backfillContentKeys();
  }

  /** Insert secondary content: fingerprints for rows that only have opaque ids. */
  private backfillContentKeys(): void {
    const rows = this.listStmt.all() as {
      track_key: string;
      platform: string | null;
      name: string | null;
      artist: string | null;
      reason: string | null;
      created_by: string | null;
      created_at: number;
    }[];
    for (const r of rows) {
      if (r.track_key.startsWith(CONTENT_KEY_PREFIX)) continue;
      const fp = blacklistContentKey(r.name, r.artist);
      if (!fp || this.hasKey(fp)) continue;
      this.insertStmt.run(fp, r.platform, r.name, r.artist, r.reason, r.created_by, r.created_at);
    }
  }

  private insertKey(
    trackKey: string,
    platform: string | null,
    name: string | null,
    artist: string | null,
    reason: string | null,
    createdBy: string | null,
    createdAt: number,
  ): void {
    if (!trackKey) return;
    this.insertStmt.run(trackKey, platform, name, artist, reason, createdBy, createdAt);
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
    const platform = entry.platform ?? null;
    const name = entry.name ?? null;
    const artist = entry.artist ?? null;
    const reason = entry.reason ?? null;
    const createdBy = entry.createdBy ?? null;

    this.insertKey(trackKey, platform, name, artist, reason, createdBy, createdAt);

    // Bare YouTube video id when the key is a full URL form.
    const vid = extractVideoId(trackKey);
    if (vid && vid !== trackKey) {
      this.insertKey(vid, platform ?? "youtube", name, artist, reason, createdBy, createdAt);
    }
    // Video id embedded in local YT-save display names: "Title [dQw4w9WgXcQ]"
    const fromName = (name ?? "").match(/\[([A-Za-z0-9_-]{11})\]/)?.[1];
    if (fromName && fromName !== trackKey && fromName !== vid) {
      this.insertKey(fromName, platform ?? "youtube", name, artist, reason, createdBy, createdAt);
    }
    // Title+artist fingerprint — blocks the same song re-seeded under a new id.
    const fp = blacklistContentKey(name, artist);
    if (fp && fp !== trackKey) {
      this.insertKey(fp, platform, name, artist, reason, createdBy, createdAt);
    }

    return {
      trackKey,
      platform,
      name,
      artist,
      reason,
      createdBy,
      createdAt,
    };
  }

  remove(trackKey: string): boolean {
    const key = trackKey.trim();
    if (!key) return false;
    // Look up metadata before deleting so we can purge related keys.
    const row = this.db
      .prepare(`SELECT track_key, name, artist FROM playback_blacklist WHERE track_key = ? LIMIT 1`)
      .get(key) as { track_key: string; name: string | null; artist: string | null } | undefined;

    let removed = this.deleteStmt.run(key).changes > 0;
    const vid = extractVideoId(key);
    if (vid && vid !== key) {
      removed = this.deleteStmt.run(vid).changes > 0 || removed;
    }
    const name = row?.name ?? null;
    const artist = row?.artist ?? null;
    const fromName = (name ?? "").match(/\[([A-Za-z0-9_-]{11})\]/)?.[1];
    if (fromName) {
      removed = this.deleteStmt.run(fromName).changes > 0 || removed;
    }
    const fp = blacklistContentKey(name, artist);
    if (fp) {
      removed = this.deleteStmt.run(fp).changes > 0 || removed;
    }
    // If caller passed a content key or name, still try to wipe matching content keys.
    if (!row) {
      const asFp = key.startsWith(CONTENT_KEY_PREFIX) ? key : blacklistContentKey(key, null);
      if (asFp) removed = this.deleteStmt.run(asFp).changes > 0 || removed;
    }
    return removed;
  }

  /** Exact key presence (one DB lookup). */
  hasKey(trackKey: string): boolean {
    if (!trackKey) return false;
    return !!this.hasStmt.get(trackKey);
  }

  /**
   * True when this song (or its YouTube video id / title fingerprint) is blacklisted.
   */
  isBlacklisted(
    song: { id?: string | null; name?: string | null; artist?: string | null } | null | undefined,
  ): boolean {
    if (!song) return false;
    if (song.id) {
      if (this.hasKey(song.id)) return true;
      const vid = extractVideoId(song.id);
      if (vid && vid !== song.id && this.hasKey(vid)) return true;
    }
    // Local YT save: basename often embeds [videoId] in the display name.
    const name = song.name ?? "";
    const m = name.match(/\[([A-Za-z0-9_-]{11})\]/);
    if (m?.[1] && this.hasKey(m[1])) return true;
    // Same track under a different platform id (local hash vs YT video id).
    const fp = blacklistContentKey(song.name, song.artist);
    if (fp && this.hasKey(fp)) return true;
    return false;
  }

  keySet(): Set<string> {
    const rows = this.listStmt.all() as { track_key: string }[];
    return new Set(rows.map((r) => r.track_key));
  }

  /**
   * User-facing ban list — hides internal content: fingerprint keys so the UI
   * doesn't show duplicate rows for the same ban.
   */
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
    return rows
      .filter((r) => !r.track_key.startsWith(CONTENT_KEY_PREFIX))
      .map((r) => ({
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
export function filterNotBlacklisted<
  T extends { id?: string | null; name?: string | null; artist?: string | null },
>(songs: T[], blacklist: PlaybackBlacklist | null | undefined): T[] {
  if (!blacklist) return songs;
  return songs.filter((s) => !blacklist.isBlacklisted(s));
}

export function blacklistedMessage(song: { name?: string; artist?: string }): string {
  const label = [song.name, song.artist].filter(Boolean).join(" — ") || "that track";
  return `Blocked by station blacklist: ${label}`;
}
