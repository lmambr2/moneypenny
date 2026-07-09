import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import axios from "axios";
import { errorMessage } from "../util/error.js";
import type {
  AuthStatus,
  LyricLine,
  MusicProvider,
  Playlist,
  SearchResult,
  Song,
} from "./provider.js";
import { isBandcampUrl, isXTwitterUrl, isYouTubeUrl } from "./stream.js";
import { assertPublicPlaybackUrl, isPublicPlaybackUrl } from "./url-guard.js";

/**
 * Only allow yt-dlp to fetch known media hosts (or a bare video/playlist id we
 * rewrite to youtube.com). Blocks SSRF via arbitrary http(s) songId/playlistId.
 */
async function safeYtDlpMediaUrl(input: string): Promise<string | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) {
    // Bare id — caller rebuilds a youtube.com URL.
    return trimmed;
  }
  if (!(isYouTubeUrl(trimmed) || isXTwitterUrl(trimmed) || isBandcampUrl(trimmed))) {
    return null;
  }
  if (!(await assertPublicPlaybackUrl(trimmed))) return null;
  return trimmed;
}

const execFileAsync = promisify(execFile);

/** Fallback for age-restricted / login-walled videos using public oEmbed (no cookies needed for basic metadata). */
async function getOEmbedEntry(videoId: string): Promise<YtDlpEntry | null> {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const { data } = await axios.get(oembedUrl, { timeout: 10000 });
    return {
      id: videoId,
      title: data.title,
      uploader: data.author_name,
      channel: data.author_name,
      duration: 0,
      thumbnail: data.thumbnail_url,
      webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
    };
  } catch {
    return null;
  }
}

/**
 * The canonical default demo / unit test video for Moneypenny.
 * Used for:
 *  - PHASE0_TEST_PLAY default on startup (auto-plays after connect for validation)
 *  - The primary YouTube unit test case (direct URL handling, metadata, stream extraction)
 *  - Docs and phase0-validate.sh examples
 */
export const DEFAULT_DEMO_VIDEO_ID = "hLOheGDwD_0";
export const DEFAULT_DEMO_VIDEO_URL = `https://www.youtube.com/watch?v=${DEFAULT_DEMO_VIDEO_ID}`;

/**
 * Extract the canonical 11-char video id from any YouTube URL form (watch?v=,
 * youtu.be/, /embed, /shorts, /live, /v) or a bare id. The reliable dedup key
 * for the YouTube → local library feature — the same video maps to one id
 * regardless of which URL variant is pasted.
 */
export function extractVideoId(input: string): string | null {
  if (!input) return null;
  const m =
    input.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    input.match(/(?:youtu\.be|\/embed|\/shorts|\/live|\/v)\/([A-Za-z0-9_-]{11})/) ||
    input.match(/^([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : null;
}

/**
 * Block multi-hour “full album” dumps that wreck the DJ queue.
 * Matches “full album”, “full-album”, “fullalbum”, etc. (case-insensitive).
 * Pure helper — unit-tested; used at search/detail/playlist and play resolve.
 */
export function isYoutubeFullAlbumTitle(title: string): boolean {
  const t = String(title || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s._-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;
  // full album | full-album | full_album | full.album | fullalbum
  if (/\bfull[\s._-]*album\b/.test(t)) return true;
  if (t.includes("fullalbum")) return true;
  return false;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve the yt-dlp binary path. Checks the project bin/ dir first, then PATH. */
function findYtDlp(): string {
  const exe = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const candidates = [
    join(__dirname, "..", "..", "bin", exe),
    join(__dirname, "..", "..", "bin", "yt-dlp"),
    exe,
  ];
  for (const c of candidates) {
    // Absolute/relative paths: only return if the file exists.
    // Bare names: return and let execFile resolve via PATH.
    const isBinPath = c.includes(join("bin", "yt-dlp"));
    if (!isBinPath || existsSync(c)) return c;
  }
  return exe;
}

/**
 * Availability check for yt-dlp. Runs `yt-dlp --version` and caches only
 * the positive result — if the binary is missing, subsequent calls retry
 * so the user can install yt-dlp while the server is running and pick it
 * up without a restart. Used by getAuthStatus() so the UI can reflect
 * whether YouTube is actually usable.
 */
let cachedAvailable = false;
let pendingCheck: Promise<boolean> | null = null;
async function checkYtDlpAvailable(): Promise<boolean> {
  if (cachedAvailable) return true;
  if (pendingCheck) return pendingCheck;
  pendingCheck = (async () => {
    try {
      await execFileAsync(findYtDlp(), ["--version"], {
        timeout: 5_000,
        maxBuffer: 1024,
      });
      cachedAvailable = true;
      return true;
    } catch {
      return false;
    } finally {
      pendingCheck = null;
    }
  })();
  return pendingCheck;
}

/** Force re-detection on the next call (for tests). */
export function resetYtDlpAvailabilityCache(): void {
  cachedAvailable = false;
  pendingCheck = null;
}

async function runYtDlp(args: string[], timeoutMs = 30_000): Promise<string> {
  const binary = findYtDlp();
  const env = { ...process.env };
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    // yt-dlp respects these env vars natively
  }
  const { stdout } = await execFileAsync(binary, args, {
    timeout: timeoutMs,
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

interface YtDlpEntry {
  id: string;
  title: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  webpage_url?: string;
  url?: string;
  extractor?: string;
  entries?: YtDlpEntry[];
  _type?: string;
}

/** Friendly source label for a non-YouTube yt-dlp entry (X/Twitter, etc.). */
function sourceLabelFor(webUrl: string, extractor?: string): string {
  if (/(^|\.)(x\.com|twitter\.com|t\.co)/i.test(webUrl)) return "X (Twitter)";
  if (extractor) return extractor.replace(/(:.*|IE$)/i, "").trim() || "Web";
  return "Web";
}

function entryToSong(entry: YtDlpEntry): Song | null {
  const title = entry.title ?? "Unknown";
  // Full-album dumps only apply to YouTube track titles (not X/Bandcamp posts).
  const webUrl = entry.webpage_url ?? "";
  const isYt =
    /youtube|youtu\.be/i.test(entry.extractor ?? "") || /youtube\.com|youtu\.be/i.test(webUrl);
  if (isYt && isYoutubeFullAlbumTitle(title)) return null;
  const label = isYt ? "YouTube" : sourceLabelFor(webUrl, entry.extractor);
  return {
    // For non-YouTube (X/Twitter/…) keep the full page URL as the id — there's no
    // youtube-style ?v= id for getSongUrl to rebuild from, so it re-resolves the URL.
    id: isYt ? (entry.id ?? "") : webUrl || entry.id || "",
    name: title,
    artist: entry.uploader ?? entry.channel ?? label,
    album: label,
    duration: Math.round(entry.duration ?? 0),
    coverUrl: entry.thumbnail ?? "",
    platform: "youtube",
  };
}

export class YouTubeProvider implements MusicProvider {
  readonly platform = "youtube" as const;
  private quality = "bestaudio";

  canHandle(query: string): boolean {
    return isYouTubeUrl(query) || isXTwitterUrl(query) || isBandcampUrl(query);
  }

  async search(query: string, limit = 5): Promise<SearchResult> {
    try {
      let raw: string;
      if (isYouTubeUrl(query) || isXTwitterUrl(query) || isBandcampUrl(query)) {
        // Direct media URL (YouTube / X-Twitter / Bandcamp) — fetch details directly instead of ytsearch.
        // Support age-restricted videos via oEmbed fallback (no cookies required for metadata).
        const safe = await safeYtDlpMediaUrl(query);
        if (!safe) return { songs: [], playlists: [], albums: [] };
        const videoId = extractVideoId(query) ?? "";
        try {
          raw = await runYtDlp([safe, "--dump-json", "--no-warnings", "--quiet"]);
          const entry = JSON.parse(raw.trim()) as YtDlpEntry;
          const song = entryToSong(entry);
          return { songs: song ? [song] : [], playlists: [], albums: [] };
        } catch (err: unknown) {
          const msg = errorMessage(err, "");
          if (
            videoId &&
            (msg.includes("age") || msg.includes("Sign in") || msg.includes("confirm your age"))
          ) {
            const oembed = await getOEmbedEntry(videoId);
            if (oembed) {
              const song = entryToSong(oembed);
              return { songs: song ? [song] : [], playlists: [], albums: [] };
            }
          }
          return { songs: [], playlists: [], albums: [] };
        }
      } else {
        raw = await runYtDlp([
          `ytsearch${limit}:${query}`,
          "--dump-json",
          "--flat-playlist",
          "--no-warnings",
          "--quiet",
        ]);
        const lines = raw.trim().split("\n").filter(Boolean);
        const songs: Song[] = [];
        for (const line of lines) {
          const entry = JSON.parse(line) as YtDlpEntry;
          const song = entryToSong(entry);
          if (song) songs.push(song);
        }
        return { songs, playlists: [], albums: [] };
      }
    } catch {
      return { songs: [], playlists: [], albums: [] };
    }
  }

  async getSongUrl(songId: string): Promise<string | null> {
    try {
      let url: string;
      if (/^https?:\/\//i.test(songId)) {
        const safe = await safeYtDlpMediaUrl(songId);
        if (!safe) return null;
        url = safe;
      } else {
        url = `https://www.youtube.com/watch?v=${songId}`;
        if (!isPublicPlaybackUrl(url)) return null;
      }
      const raw = await runYtDlp(
        [
          url,
          "--get-url",
          "-f",
          "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio",
          "--no-warnings",
          "--quiet",
        ],
        45_000,
      );
      const audioUrl = raw.trim().split("\n")[0];
      // CDN hop from yt-dlp — reject private literals AND private DNS resolution.
      if (audioUrl && !(await assertPublicPlaybackUrl(audioUrl))) return null;
      return audioUrl || null;
    } catch {
      return null;
    }
  }

  /**
   * Download a video's audio as a tagged MP3 (ROADMAP: YouTube → local library).
   * Embeds metadata + thumbnail cover art so LocalProvider indexes it as a proper
   * track. Writes `<outDir>/<baseName>.mp3` and returns that path; throws on
   * failure so the caller can fall back to streaming and skip saving.
   */
  async downloadAudioMp3(videoId: string, outDir: string, baseName: string): Promise<string> {
    mkdirSync(outDir, { recursive: true });
    let url: string;
    if (/^https?:\/\//i.test(videoId)) {
      const safe = await safeYtDlpMediaUrl(videoId);
      if (!safe) throw new Error("refusing yt-dlp download of non-public / non-media URL");
      url = safe;
    } else {
      url = `https://www.youtube.com/watch?v=${videoId}`;
    }
    const outTemplate = join(outDir, `${baseName}.%(ext)s`);
    await runYtDlp(
      [
        url,
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        "0",
        "--embed-metadata",
        "--embed-thumbnail",
        "--no-playlist",
        "--no-warnings",
        "--quiet",
        "-o",
        outTemplate,
      ],
      300_000,
    );
    const finalPath = join(outDir, `${baseName}.mp3`);
    if (!existsSync(finalPath)) throw new Error(`yt-dlp finished but ${finalPath} not found`);
    return finalPath;
  }

  setQuality(quality: string): void {
    this.quality = quality;
  }

  getQuality(): string {
    return this.quality;
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    try {
      let url: string;
      if (/^https?:\/\//i.test(songId)) {
        const safe = await safeYtDlpMediaUrl(songId);
        if (!safe) return null;
        url = safe;
      } else {
        url = `https://www.youtube.com/watch?v=${songId}`;
      }
      const raw = await runYtDlp([url, "--dump-json", "--no-warnings", "--quiet"]);
      const entry = JSON.parse(raw.trim()) as YtDlpEntry;
      return entryToSong(entry);
    } catch (err: unknown) {
      const msg = errorMessage(err, "");
      if (msg.includes("age") || msg.includes("Sign in") || msg.includes("confirm your age")) {
        const id = extractVideoId(songId) ?? songId;
        const oembed = await getOEmbedEntry(id);
        if (oembed) return entryToSong(oembed);
      }
      return null;
    }
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    try {
      let url: string;
      if (/^https?:\/\//i.test(playlistId)) {
        // Only YouTube playlist hosts — never arbitrary http(s).
        if (!isYouTubeUrl(playlistId)) return [];
        if (!(await assertPublicPlaybackUrl(playlistId))) return [];
        url = playlistId;
      } else {
        // Sanitize playlist id (no path injection into the query string).
        if (!/^[A-Za-z0-9_-]+$/.test(playlistId)) return [];
        url = `https://www.youtube.com/playlist?list=${playlistId}`;
      }
      const raw = await runYtDlp(
        [url, "--dump-json", "--flat-playlist", "--no-warnings", "--quiet"],
        60_000,
      );
      const lines = raw.trim().split("\n").filter(Boolean);
      const songs: Song[] = [];
      for (const line of lines) {
        const song = entryToSong(JSON.parse(line) as YtDlpEntry);
        if (song) songs.push(song);
      }
      return songs;
    } catch {
      return [];
    }
  }

  async getRecommendPlaylists(): Promise<Playlist[]> {
    return [];
  }

  async getAlbumSongs(_albumId: string): Promise<Song[]> {
    return [];
  }

  async getLyrics(_songId: string): Promise<LyricLine[]> {
    return [];
  }

  async getAuthStatus(): Promise<AuthStatus> {
    // YouTube has no login concept via yt-dlp, so "loggedIn" here means
    // "yt-dlp binary is reachable and responds to --version". The UI can
    // use this flag to grey out YouTube when the optional dependency is
    // missing, instead of silently returning empty search results.
    const available = await checkYtDlpAvailable();
    if (available) {
      return { loggedIn: true, nickname: "YouTube (yt-dlp)" };
    }
    return {
      loggedIn: false,
      nickname: "YouTube (yt-dlp not installed)",
    };
  }
}
