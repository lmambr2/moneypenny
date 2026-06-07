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
  QrCodeResult,
  AuthStatus,
} from "./provider.js";

export interface LocalProviderOptions {
  musicDir: string;
  /** File extensions to index (case-insensitive) */
  extensions?: string[];
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

  constructor(options: LocalProviderOptions) {
    this.musicDir = path.resolve(options.musicDir);
    this.supportedExtensions = new Set(
      (options.extensions ?? [".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".wma", ".opus"]).map(e => e.toLowerCase())
    );
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

  private extractCoverUrl(pictures?: musicMetadata.IPicture[]): string {
    if (!pictures || pictures.length === 0) {
      return "";
    }
    const pic = pictures[0];
    const mime = pic.format || "image/jpeg";
    const base64 = Buffer.from(pic.data).toString("base64");
    return `data:${mime};base64,${base64}`;
  }

  // --- MusicProvider implementation ---

  async search(query: string, limit = 50): Promise<SearchResult> {
    await this.ensureIndexed();

    const q = query.toLowerCase().trim();
    if (!q) {
      return { songs: [], playlists: [], albums: [] };
    }

    const matches = this.songs
      .filter(song =>
        song.name.toLowerCase().includes(q) ||
        song.artist.toLowerCase().includes(q) ||
        song.album.toLowerCase().includes(q)
      )
      .slice(0, limit)
      .map(({ absolutePath, ...song }) => song); // Don't leak absolutePath to callers

    return {
      songs: matches,
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
    return this.songs
      .filter(s => s.album.toLowerCase() === albumId.toLowerCase())
      .map(({ absolutePath, ...song }) => song);
  }

  async getLyrics(_songId: string): Promise<LyricLine[]> {
    return [];
  }

  async getQrCode(): Promise<QrCodeResult> {
    throw new Error("LocalProvider does not support QR login");
  }

  async checkQrCodeStatus(_key: string): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    return "expired";
  }

  setCookie(_cookie: string): void {
    // Not applicable
  }

  getCookie(): string {
    return "";
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
      // Path isn't validated here — getSongUrl runs the containment check at play
      // time. The ID is opaque so the path never crosses the API (F-2).
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

      // It's a valid audio file even if not pre-indexed (e.g. new file)
      const name = path.basename(safePath, path.extname(safePath));
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
}
