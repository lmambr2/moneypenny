import type Database from "better-sqlite3";
import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { Logger } from "../logger.js";

export interface SongMeta {
  name: string;
  artist: string;
  duration?: number;
}

/** Local provider surface used by YtLibrary (save dir + post-save re-index). */
export interface YtLibraryLocalSource {
  getMusicDir(): string;
  refresh(): Promise<unknown>;
}

/** YouTube provider surface used by YtLibrary (background MP3 download). */
export interface YtLibraryYoutubeSource {
  downloadAudioMp3(videoId: string, outDir: string, baseName: string): Promise<string>;
}

export interface YtLibraryOptions {
  db: Database.Database;
  /** Absolute music library root (saved MP3s go in a subdir so LocalProvider indexes them). */
  musicDir: string;
  /** Download a video's audio as MP3 into `<outDir>/<baseName>.mp3`; returns the path. */
  download: (videoId: string, outDir: string, baseName: string) => Promise<string>;
  /** Re-index the local library after a save so the new track becomes searchable. */
  refresh: () => Promise<unknown>;
  logger?: Logger;
}

/** Subdir under MUSIC_DIR holding saved YouTube tracks (still part of the indexed library). */
const SAVE_SUBDIR = "youtube";

/**
 * YouTube → permanent local library (ROADMAP "Adjacent feature"). Maps a
 * canonical video id → a saved, tagged MP3 in the library, so replaying the same
 * video (any URL form) serves the local file instead of re-streaming/-downloading.
 * Saves run in the background (stream-first UX) behind an in-flight lock; a failed
 * save never affects playback. Backed by the bot's existing SQLite db.
 */
export class YtLibrary {
  private db: Database.Database;
  private musicDir: string;
  private download: YtLibraryOptions["download"];
  private refresh: YtLibraryOptions["refresh"];
  private logger?: Logger;
  private inFlight = new Set<string>();
  private getStmt: Database.Statement;
  private addStmt: Database.Statement;

  constructor(opts: YtLibraryOptions) {
    this.db = opts.db;
    this.musicDir = opts.musicDir;
    this.download = opts.download;
    this.refresh = opts.refresh;
    this.logger = opts.logger;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS yt_saved (
        video_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        duration INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
    this.getStmt = this.db.prepare(`SELECT path FROM yt_saved WHERE video_id = ?`);
    this.addStmt = this.db.prepare(
      `INSERT OR REPLACE INTO yt_saved (video_id, path, title, artist, duration, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
  }

  /** Saved local MP3 path for a video id, if saved AND the file still exists; else null. */
  lookup(videoId: string): string | null {
    if (!videoId) return null;
    const row = this.getStmt.get(videoId) as { path: string } | undefined;
    if (row?.path && existsSync(row.path)) return row.path;

    const onDisk = findSavedOnDisk(this.musicDir, videoId);
    if (onDisk) {
      this.reconcileDiskHit(videoId, onDisk);
      return onDisk;
    }
    return null;
  }

  /** Register an on-disk save the DB missed (e.g. after manual copy or DB reset). */
  private reconcileDiskHit(videoId: string, filePath: string): void {
    const row = this.getStmt.get(videoId) as { path: string } | undefined;
    if (row?.path && existsSync(row.path)) return;
    const meta = parseSavedFilename(path.basename(filePath), videoId);
    this.addStmt.run(videoId, filePath, meta.title, meta.artist, 0, Date.now());
  }

  /**
   * Download + save a video as a tagged MP3 in the background (fire-and-forget).
   * No-op if already saved or a save is in-flight. Errors are swallowed (logged) —
   * a failed save must never affect the already-playing stream.
   */
  saveInBackground(videoId: string, meta: SongMeta): void {
    if (!videoId || this.lookup(videoId) || this.inFlight.has(videoId)) return;
    this.inFlight.add(videoId);
    const outDir = path.join(this.musicDir, SAVE_SUBDIR);
    const base = sanitizeBase(meta, videoId);
    void (async () => {
      try {
        this.logger?.info({ videoId, title: meta.name }, "YT save: downloading");
        const savedPath = await this.download(videoId, outDir, base);
        this.addStmt.run(videoId, savedPath, meta.name || videoId, meta.artist || "YouTube", meta.duration ?? 0, Date.now());
        await this.refresh();
        this.logger?.info({ videoId, path: savedPath }, "YT save: saved to library");
      } catch (err) {
        this.logger?.warn({ err, videoId }, "YT save failed (kept streaming)");
      } finally {
        this.inFlight.delete(videoId);
      }
    })();
  }
}

/** Find a saved YouTube MP3 on disk by the `[videoId]` tag in its filename. */
export function findSavedOnDisk(musicDir: string, videoId: string): string | null {
  if (!videoId) return null;
  const dir = path.join(musicDir, SAVE_SUBDIR);
  if (!existsSync(dir)) return null;

  const tag = `[${videoId}]`;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith(".mp3")) continue;
      if (!name.includes(tag)) continue;
      const full = path.join(dir, name);
      if (existsSync(full)) return full;
    }
  } catch {
    return null;
  }
  return null;
}

/** Parse `<artist> - <title> [videoId].mp3` written by {@link sanitizeBase}. */
export function parseSavedFilename(basename: string, videoId: string): { title: string; artist: string } {
  const escaped = videoId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = basename.match(new RegExp(`^(.+?) - (.+) \\[${escaped}\\]\\.mp3$`, "i"));
  if (m) {
    return { artist: m[1].trim(), title: m[2].trim() };
  }
  return { title: videoId, artist: "YouTube" };
}

/** Build a filesystem-safe base name: `<artist> - <title> [videoId]`. */
export function sanitizeBase(meta: SongMeta, videoId: string): string {
  const raw = [meta.artist, meta.name].filter(Boolean).join(" - ") || videoId;
  const safe = raw.replace(/[\/\\?%*:|"<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 150);
  return `${safe || videoId} [${videoId}]`;
}
