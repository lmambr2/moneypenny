import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as musicMetadata from "music-metadata";
import type {
  MusicProvider,
  Song,
  SongWithUrl,
  Playlist,
  PlaylistDetail,
  Album,
  SearchResult,
  LyricLine,
  AuthStatus,
} from "./provider.js";

export interface LocalProviderOptions {
  musicDir: string;
  /** File extensions to index (case-insensitive) */
  extensions?: string[];
  /** Ids to hide from music discovery (search/albums) — bumper-flagged assets
   *  so they never surface as songs (docs/radio.md §9.2). Resolved lazily so a
   *  live TagStore can back it. */
  excludedIds?: () => Set<string>;
}

interface IndexedSong extends Song {
  absolutePath: string;
}

export class LocalProvider implements MusicProvider {
  readonly platform = "local" as const;

  private musicDir: string;
  private songs: IndexedSong[] = [];
  private indexed = false;
  private indexingPromise: Promise<void> | null = null;
  // Opaque public ID -> real filesystem path. Keeps absolute paths out of every
  // field that crosses the API (audit F-2); getSongUrl resolves back through it.
  private idToPath = new Map<string, string>();
  private playlistIdToPath = new Map<string, string>();

  private readonly supportedExtensions: Set<string>;
  private readonly excludedIds?: () => Set<string>;

  constructor(options: LocalProviderOptions) {
    this.musicDir = path.resolve(options.musicDir);
    this.excludedIds = options.excludedIds;
    this.supportedExtensions = new Set(
      (options.extensions ?? [".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".wma", ".opus"]).map(e => e.toLowerCase())
    );
  }

  /** Songs visible to music discovery — excludes bumper-flagged assets (§9.2)
   *  so they never surface as songs. ponytail: hides from search/albums only; a
   *  direct id/path resolve still plays them (that's how the prerecorded bumper
   *  source fetches them). */
  private visibleSongs(): IndexedSong[] {
    const excluded = this.excludedIds?.();
    if (!excluded || excluded.size === 0) return this.songs;
    return this.songs.filter(s => !excluded.has(s.id));
  }

  /** Stable, opaque public ID for a path — never expose the path itself (F-2). */
  private opaqueId(realPath: string): string {
    return createHash("sha1").update(realPath).digest("hex");
  }

  private async ensureIndexed(): Promise<void> {
    if (this.indexed) return;
    if (this.indexingPromise) {
      await this.indexingPromise;
      return;
    }

    this.indexingPromise = this.scanDirectory();
    await this.indexingPromise;
    this.indexed = true;
  }

  private async scanDirectory(): Promise<void> {
    this.songs = [];
    this.idToPath.clear();
    this.playlistIdToPath.clear();
    this.m3uPlaylists.clear();
    this.m3uSongs.clear();
    try {
      await this.walk(this.musicDir);
      console.log(`[LocalProvider] Indexed ${this.songs.length} tracks from ${this.musicDir}`);
    } catch (err) {
      console.error("[LocalProvider] Failed to scan music directory:", err);
    }
  }

  // Bound recursion as belt-and-suspenders against pathological trees. Real
  // directory trees can't cycle once we refuse to follow symlinked dirs.
  private static readonly MAX_WALK_DEPTH = 64;

  private async walk(dir: string, depth = 0): Promise<void> {
    if (depth > LocalProvider.MAX_WALK_DEPTH) {
      console.warn(`[LocalProvider] Max directory depth reached, skipping: ${dir}`);
      return;
    }

    // withFileTypes gives lstat-like Dirents, so a symlinked dir reports as a
    // symlink (not a directory) and we never recurse into it.
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // F-1: never follow symlinked directories — a `music/loop -> .` cycle or a
      // `music/x -> /` escape would otherwise hang/DoS the indexer. Symlinked
      // *files* are still allowed; indexFile re-checks realpath containment.
      if (entry.isSymbolicLink()) {
        let st: Awaited<ReturnType<typeof fs.stat>>;
        try {
          st = await fs.stat(fullPath);
        } catch {
          continue; // dangling symlink
        }
        if (st.isFile()) await this.indexByExtension(fullPath);
        continue; // symlinked dirs (and anything else) are skipped
      }

      if (entry.isDirectory()) {
        await this.walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        await this.indexByExtension(fullPath);
      }
    }
  }

  /** Index a regular file by extension (audio track or m3u playlist). */
  private async indexByExtension(fullPath: string): Promise<void> {
    const ext = path.extname(fullPath).toLowerCase();
    if (this.supportedExtensions.has(ext)) {
      await this.indexFile(fullPath);
    } else if (ext === '.m3u' || ext === '.m3u8') {
      await this.indexM3uFile(fullPath);
    }
  }

  private async indexFile(absolutePath: string): Promise<void> {
    try {
      const realPath = await fs.realpath(absolutePath);
      const realDir = await fs.realpath(this.musicDir);

      // Security: ensure the file is inside the music directory (no symlink escape)
      if (!realPath.startsWith(realDir + path.sep) && realPath !== realDir) {
        console.warn(`[LocalProvider] Skipping file outside music dir: ${realPath}`);
        return;
      }

      const metadata = await musicMetadata.parseFile(realPath, {
        duration: true,
        skipCovers: false,
      });

      const common = metadata.common;

      const id = this.opaqueId(realPath);
      this.idToPath.set(id, realPath);

      const song: IndexedSong = {
        id, // opaque, stable ID (F-2: never the raw filesystem path)
        name: common.title || path.basename(realPath, path.extname(realPath)),
        artist: common.artist || common.albumartist || "Unknown Artist",
        album: common.album || "Unknown Album",
        duration: Math.round(metadata.format.duration || 0),
        coverUrl: this.extractCoverUrl(common.picture),
        platform: "local",
        absolutePath: realPath,
      };

      this.songs.push(song);
    } catch (err) {
      // Skip unreadable or non-audio files silently in production
      // console.debug(`[LocalProvider] Could not parse ${absolutePath}:`, err);
    }
  }

  /** Cap embedded covers so library/search JSON cannot bloat into multi‑MB responses. */
  private static readonly MAX_EMBEDDED_COVER_BYTES = 48 * 1024;

  private extractCoverUrl(pictures?: musicMetadata.IPicture[]): string {
    if (!pictures || pictures.length === 0) {
      return "";
    }
    const pic = pictures[0];
    if (!pic.data || pic.data.length === 0) return "";
    if (pic.data.length > LocalProvider.MAX_EMBEDDED_COVER_BYTES) {
      // Large art still lives in the file; omit from list payloads (audit F5).
      return "";
    }
    const mime = pic.format || "image/jpeg";
    const base64 = Buffer.from(pic.data).toString("base64");
    return `data:${mime};base64,${base64}`;
  }

  // --- MusicProvider implementation ---

  async search(query: string, limit = 50): Promise<SearchResult> {
    await this.ensureIndexed();

    const q = query.toLowerCase().trim();
    let matches: IndexedSong[];
    if (!q) {
      // Empty query: return a sample of the library (for home/library views).
      // Order is walk order (fs readdir); uploads appear after refresh.
      matches = this.visibleSongs();
    } else {
      matches = this.visibleSongs().filter(song =>
        song.name.toLowerCase().includes(q) ||
        song.artist.toLowerCase().includes(q) ||
        song.album.toLowerCase().includes(q)
      );
    }

    const sliced = matches
      .slice(0, limit)
      .map(({ absolutePath, ...song }) => song); // Don't leak absolutePath to callers

    return {
      songs: sliced,
      playlists: [],
      albums: [],
    };
  }

  async getSongUrl(songId: string): Promise<string | null> {
    // Map an opaque ID back to its path; fall back to treating the input as a
    // path (m3u entries, direct user input). safeResolve is the single security
    // boundary and always enforces music-dir containment.
    const candidate = this.idToPath.get(songId) ?? songId;
    const safePath = await this.safeResolve(candidate);
    if (!safePath) return null;
    return safePath; // ffmpeg / the player can play local file paths directly
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    await this.ensureIndexed();
    const found = this.songs.find(s => s.id === songId);
    if (!found) return null;
    const { absolutePath, ...song } = found;
    return song;
  }

  setQuality(_quality: string): void {
    // No-op for local files
  }

  getQuality(): string {
    return "original";
  }

  async getRecommendPlaylists(): Promise<Playlist[]> {
    return [];
  }

  async getAlbumSongs(albumId: string): Promise<Song[]> {
    await this.ensureIndexed();
    return this.visibleSongs()
      .filter(s => s.album.toLowerCase() === albumId.toLowerCase())
      .map(({ absolutePath, ...song }) => song);
  }

  async getLyrics(_songId: string): Promise<LyricLine[]> {
    return [];
  }

  async getAuthStatus(): Promise<AuthStatus> {
    return { loggedIn: true, nickname: "Local Library" };
  }

  // Optional methods
  async getUserPlaylists?(): Promise<Playlist[]> {
    return [];
  }

  // --- Security helper ---

  private async safeResolve(requested: string): Promise<string | null> {
    try {
      const resolved = path.resolve(this.musicDir, requested);
      const real = await fs.realpath(resolved);
      const realBase = await fs.realpath(this.musicDir);

      if (real === realBase || real.startsWith(realBase + path.sep)) {
        return real;
      }
      console.warn(`[LocalProvider] Path traversal attempt blocked: ${requested}`);
      return null;
    } catch {
      return null;
    }
  }

  // --- M3U Playlist Support (DESIGN §7.1) ---

  private m3uPlaylists: Map<string, Playlist> = new Map();
  private m3uSongs: Map<string, Song[]> = new Map(); // playlist id -> songs

  private async indexM3uFile(absolutePath: string): Promise<void> {
    try {
      const realPath = await fs.realpath(absolutePath);
      const realDir = await fs.realpath(this.musicDir);
      if (!realPath.startsWith(realDir + path.sep) && realPath !== realDir) return;

      const content = await fs.readFile(realPath, 'utf-8');
      const songs = this.parseM3u(content, path.dirname(realPath));

      if (songs.length === 0) return;

      const name = path.basename(realPath, path.extname(realPath));
      const id = this.opaqueId(realPath);
      this.playlistIdToPath.set(id, realPath);
      const playlist: Playlist = {
        id, // opaque (F-2)
        name,
        coverUrl: '',
        songCount: songs.length,
        platform: 'local',
      };

      // Internal maps stay keyed by real path (resolve() looks up by path).
      this.m3uPlaylists.set(realPath, playlist);
      this.m3uSongs.set(realPath, songs);
    } catch {
      // ignore bad m3u files
    }
  }

  private parseM3u(content: string, baseDir: string): Song[] {
    const lines = content.split(/\r?\n/);
    const songs: Song[] = [];
    let currentName = '';
    let currentArtist = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#EXTM3U')) continue;

      if (trimmed.startsWith('#EXTINF:')) {
        // #EXTINF:duration,Artist - Title or just Title
        const info = trimmed.substring(8);
        const commaIdx = info.indexOf(',');
        const afterComma = commaIdx >= 0 ? info.substring(commaIdx + 1) : info;
        const dashIdx = afterComma.indexOf(' - ');
        if (dashIdx >= 0) {
          currentArtist = afterComma.substring(0, dashIdx).trim();
          currentName = afterComma.substring(dashIdx + 3).trim();
        } else {
          currentName = afterComma.trim();
          currentArtist = 'Unknown';
        }
        continue;
      }

      if (trimmed.startsWith('#')) continue;

      // This is a file path (relative or absolute)
      const filePath = path.resolve(baseDir, trimmed);
      // F-3: lexical containment check at parse time (defense in depth) so an
      // in-dir .m3u can't introduce out-of-tree entries (../../etc/passwd,
      // absolute paths) into the listing. getSongUrl still runs the
      // authoritative realpath check at play time; IDs are opaque (F-2).
      if (filePath !== this.musicDir && !filePath.startsWith(this.musicDir + path.sep)) {
        currentName = '';
        currentArtist = '';
        continue;
      }
      const id = this.opaqueId(filePath);
      this.idToPath.set(id, filePath);
      songs.push({
        id,
        name: currentName || path.basename(trimmed, path.extname(trimmed)),
        artist: currentArtist,
        album: 'Playlist',
        duration: 0,
        coverUrl: '',
        platform: 'local',
      });

      currentName = '';
      currentArtist = '';
    }

    return songs;
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    await this.ensureIndexed();
    const realPath = this.playlistIdToPath.get(playlistId) ?? playlistId;
    return this.m3uSongs.get(realPath) ?? [];
  }

  // --- Certainty-based resolve (DESIGN §7.4) ---

  /**
   * resolve tries to turn a raw user string into a local song/playlist.
   * High certainty for anything that looks like a path inside the music dir.
   * Returns the first strong match or null (caller can fall back to YouTube etc).
   */
  async resolve(input: string): Promise<{ type: 'song' | 'playlist'; item: Song | Playlist } | null> {
    const trimmed = input.trim();
    if (!trimmed) return null;

    await this.ensureIndexed();

    // High certainty: direct file path or relative path that exists
    const safePath = await this.safeResolve(trimmed);
    if (safePath) {
      // Check if it's one of our indexed songs
      const song = this.songs.find(s => s.absolutePath === safePath);
      if (song) {
        const { absolutePath, ...clean } = song;
        return { type: 'song', item: clean };
      }

      // Check if it's an M3U
      if (this.m3uPlaylists.has(safePath)) {
        return { type: 'playlist', item: this.m3uPlaylists.get(safePath)! };
      }

      // It's a valid in-dir file. F-3: only treat it as a playable song if it's
      // a supported audio extension — otherwise resolve("notes.txt") would yield
      // a bogus song ffmpeg can't play. Fall through to filename matching instead.
      const ext = path.extname(safePath).toLowerCase();
      if (this.supportedExtensions.has(ext)) {
        const name = path.basename(safePath, ext);
        const id = this.opaqueId(safePath);
        this.idToPath.set(id, safePath);
        return {
          type: 'song',
          item: {
            id,
            name,
            artist: 'Unknown',
            album: 'Unknown',
            duration: 0,
            coverUrl: '',
            platform: 'local',
          },
        };
      }
    }

    // Medium certainty: filename match among indexed songs
    const lower = trimmed.toLowerCase();
    const filenameMatch = this.songs.find(s =>
      path.basename(s.absolutePath).toLowerCase().includes(lower)
    );
    if (filenameMatch) {
      const { absolutePath, ...clean } = filenameMatch;
      return { type: 'song', item: clean };
    }

    return null;
  }

  // --- Upload + refresh (web UI support) ---

  /** Absolute music library root — used by the YouTube auto-save feature to write into the library. */
  getMusicDir(): string {
    return this.musicDir;
  }

  /** Server-side track list for the radio analyzer (path + stable overlay key).
   *  Exposes absolutePath, but only in-process (never crosses the API). */
  async listForAnalysis(): Promise<{ absPath: string; trackKey: string }[]> {
    await this.ensureIndexed();
    return this.songs.map((s) => ({ absPath: s.absolutePath, trackKey: s.id }));
  }

  /** Resolve a stable public id back to an on-disk path (in-process only). */
  async pathForId(trackId: string): Promise<string | null> {
    await this.ensureIndexed();
    return this.idToPath.get(trackId) ?? null;
  }

  /**
   * Find a track saved from YouTube (filename contains `[videoId]`).
   * Used by !test and YouTube playback to prefer a local copy over streaming.
   */
  async findSongByVideoId(videoId: string): Promise<Song | null> {
    if (!videoId) return null;
    await this.ensureIndexed();
    const tag = `[${videoId.toLowerCase()}]`;
    const found = this.songs.find((s) => path.basename(s.absolutePath).toLowerCase().includes(tag));
    if (!found) return null;
    const { absolutePath: _p, ...song } = found;
    return song;
  }

  /**
   * Force a full re-scan. Safe to call after host-side adds or web uploads.
   * Next search/resolve will see the new files.
   * Returns the number of indexed tracks after refresh.
   */
  async refresh(): Promise<number> {
    this.indexed = false;
    this.indexingPromise = null;
    await this.ensureIndexed();
    return this.songs.length;
  }

  /** Indexed track count without forcing a rescan. */
  async getTrackCount(): Promise<number> {
    await this.ensureIndexed();
    return this.songs.length;
  }

  /**
   * Delete a track from disk by opaque public id (admin web UI).
   *
   * - Resolves id → path via the index; refuses unknown ids
   * - Enforces musicDir containment via realpath (same as safeResolve)
   * - Unlinks the file only (does not remove parent dirs)
   * - Re-indexes so search/library drop the track immediately
   */
  async deleteSong(songId: string): Promise<{ deleted: true; name: string }> {
    await this.ensureIndexed();
    const abs = this.idToPath.get(songId);
    if (!abs) {
      throw Object.assign(new Error("Track not found in library index"), { code: "NOT_FOUND" });
    }

    let real: string;
    let realBase: string;
    try {
      real = await fs.realpath(abs);
      realBase = await fs.realpath(this.musicDir);
    } catch {
      throw Object.assign(new Error("Track file is missing on disk"), { code: "NOT_FOUND" });
    }
    if (real !== realBase && !real.startsWith(realBase + path.sep)) {
      console.warn(`[LocalProvider] deleteSong blocked outside musicDir: ${songId}`);
      throw Object.assign(new Error("Refusing to delete path outside music library"), {
        code: "FORBIDDEN",
      });
    }
    if (real === realBase) {
      throw Object.assign(new Error("Refusing to delete the music library root"), {
        code: "FORBIDDEN",
      });
    }

    const indexed = this.songs.find((s) => s.id === songId);
    const name = indexed?.name ?? path.basename(real);

    try {
      await fs.unlink(real);
    } catch (e: unknown) {
      const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
      if (code === "ENOENT") {
        // Already gone — still re-index so the UI clears the ghost entry.
      } else {
        throw e;
      }
    }

    await this.refresh();
    return { deleted: true, name };
  }

  /**
   * Upload a song file (from web UI) into the music library.
   *
   * SECURITY / AUDIT NOTE ("secure that mfer"):
   *   Web-originated uploads are **isolated to the `uploads/` subdirectory**
   *   under the configured MUSIC_DIR. This makes it trivial to:
   *   - Audit / ls what came from the UI vs. host-managed files
   *   - Apply different host permissions, snapshots, or .dockerignore rules
   *   - Monitor or later add per-subdir scanning / quarantine rules
   *   The recursive walker still indexes them automatically.
   *
   * - Sanitizes filename (no traversal, restricted chars)
   * - Ensures unique name (appends " (n)" if needed)
   * - Writes via tmp + rename for basic atomicity
   * - Triggers refresh so it is immediately searchable/indexed
   * - Returns a clean Song (no absolutePath leak)
   */
  async uploadSong(originalFilename: string, data: Buffer): Promise<Song> {
    // Sanitize to a safe basename only
    let base = path.basename(originalFilename || "upload.bin");
    // Remove directory separators and most dangerous chars for cross-fs safety
    base = base.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!base) base = "upload.mp3";
    const ext = path.extname(base).toLowerCase();
    if (!this.supportedExtensions.has(ext)) {
      throw new Error("Unsupported audio format. Allowed: " + Array.from(this.supportedExtensions).join(", "));
    }

    // Uploads go into a dedicated subdir so we can "secure that mfer"
    // (audit, perms, exclusion, etc.). Still under musicDir so the walker finds it.
    const uploadsDir = path.join(this.musicDir, "uploads");
    await fs.mkdir(uploadsDir, { recursive: true });

    // Choose a non-colliding target path inside uploads/
    let target = path.join(uploadsDir, base);
    let counter = 0;
    const nameNoExt = path.basename(base, ext);
    while (true) {
      try {
        await fs.access(target);
        counter += 1;
        target = path.join(uploadsDir, `${nameNoExt} (${counter})${ext}`);
      } catch {
        break; // does not exist → usable
      }
      if (counter > 9999) {
        throw new Error("Too many name collisions");
      }
    }

    // Write to .tmp then rename (best-effort atomic on same volume)
    const tmpPath = target + ".uploading";
    try {
      await fs.writeFile(tmpPath, data);
      await fs.rename(tmpPath, target);
    } catch (e) {
      // cleanup partial
      try { await fs.unlink(tmpPath); } catch {}
      throw e;
    }

    // Re-index so search/resolve/cards see it (and get real metadata/cover)
    await this.refresh();

    // Return the clean song object using our ID system
    const realPath = await fs.realpath(target);
    const id = this.opaqueId(realPath);
    // idToPath was populated during refresh's indexFile
    const song = await this.getSongDetail(id);
    if (song) return song;

    // Fallback (shouldn't happen)
    return {
      id,
      name: path.basename(target, ext),
      artist: "Unknown Artist",
      album: "Unknown Album",
      duration: 0,
      coverUrl: "",
      platform: "local",
    };
  }
}
