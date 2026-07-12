import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import axios from "axios";
import { errorMessage } from "../util/error.js";
import { shouldBlockAsNonMusic, type YtDlpMusicMeta } from "./non-music.js";
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
export async function safeYtDlpMediaUrl(input: string): Promise<string | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) {
    // Non-http(s) schemes (ftp:, file:, data:, …) parse as URLs with an
    // allowlisted hostname but would skip the public-URL guard — reject them
    // so only true bare ids fall through.
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
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
 * True when the song is the canonical !test / PHASE0 demo track (YouTube id or
 * a local YT-save whose name embeds `[videoId]`). Used to rights-gate skip/clear.
 */
export function isDemoTestTrack(
  song: { id?: string | null; name?: string | null; album?: string | null } | null | undefined,
): boolean {
  if (!song) return false;
  const id = song.id ?? "";
  if (id === DEFAULT_DEMO_VIDEO_ID) return true;
  if (extractVideoId(id) === DEFAULT_DEMO_VIDEO_ID) return true;
  const blob = `${song.name ?? ""} ${song.album ?? ""} ${id}`.toLowerCase();
  return blob.includes(DEFAULT_DEMO_VIDEO_ID.toLowerCase());
}

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

/** Max YouTube play length (seconds). Longer dumps (albums, mixes) are skipped. */
export const YOUTUBE_MAX_DURATION_SEC = 15 * 60;

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

/**
 * YouTube 24/7 livestream "radios" (Lofi Girl–style, "Classic Rock Radio LIVE")
 * return no extractable URL via yt-dlp and leave dead air. Detect by title
 * signals that normal tracks almost never use.
 *
 * Pure helper — unit-tested; used at search, seed, and play resolve.
 */
export function isYoutubeLivestreamRadioTitle(title: string): boolean {
  const raw = String(title || "").normalize("NFKC");
  if (!raw.trim()) return false;
  const t = raw.toLowerCase();

  // Explicit live / radio-stream markers (keep [LIVE] before stripping brackets).
  if (/\[\s*live\s*\]/i.test(raw)) return true;
  if (/\b24\s*\/\s*7\b/i.test(raw)) return true;
  if (/\blive\s*stream\b|\blivestream\b/i.test(t)) return true;
  if (/\bnonstop\b/i.test(t) && /\b(radio|hits|classic|rock|mix|music)\b/i.test(t)) return true;
  // Lofi Girl–style: "beats to chill/game to", "beats to study to"
  if (/\bbeats\s+to\b/i.test(t)) return true;
  // Live radio / 24-7 radio without brackets
  if (/\bradio\b/i.test(t) && (/\blive\b/i.test(t) || /\b24\s*\/?\s*7\b/i.test(t))) return true;
  // YT live titles append a rolling clock: "... 2026-07-12 00:33"
  if (/\b20\d{2}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\b/.test(raw)) return true;

  return false;
}

/** yt-dlp live flags — never queue as a discrete radio track. */
export function isYtDlpLiveStream(meta: YtDlpMusicMeta | null | undefined): boolean {
  if (!meta) return false;
  if (meta.is_live === true) return true;
  const status = typeof meta.live_status === "string" ? meta.live_status.toLowerCase() : "";
  return status === "is_live" || status === "is_upcoming" || status === "post_live";
}

/**
 * True when duration is known and exceeds the 15-minute cap.
 * Unknown/zero duration is allowed (oEmbed age-restricted path often lacks it).
 */
export function isYoutubeTooLong(durationSec: number | null | undefined): boolean {
  const d = Number(durationSec);
  if (!Number.isFinite(d) || d <= 0) return false;
  return d > YOUTUBE_MAX_DURATION_SEC;
}

/** Combined gate for YouTube queue pollution (title dump, non-music, or over-long). */
export function shouldBlockYoutubeSong(opts: {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
  /** yt-dlp info-json subset when available (preferred over title-only). */
  ytMeta?: YtDlpMusicMeta | null;
}): boolean {
  if (isYoutubeFullAlbumTitle(opts.title ?? "")) return true;
  if (isYoutubeLivestreamRadioTitle(opts.title ?? "")) return true;
  if (isYtDlpLiveStream(opts.ytMeta)) return true;
  if (isYoutubeTooLong(opts.duration)) return true;
  if (
    shouldBlockAsNonMusic(
      {
        name: opts.title,
        artist: opts.artist,
        album: opts.album,
      },
      opts.ytMeta,
    )
  ) {
    return true;
  }
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
  /** YouTube primary category list (e.g. `["Music"]`). */
  categories?: string[] | string;
  tags?: string[] | string;
  track?: string;
  album?: string;
  album_artist?: string;
  artist?: string;
  genre?: string;
  channel_id?: string;
  is_live?: boolean;
  live_status?: string;
}

/** Friendly source label for a non-YouTube yt-dlp entry (X/Twitter, etc.). */
function sourceLabelFor(webUrl: string, extractor?: string): string {
  if (/(^|\.)(x\.com|twitter\.com|t\.co)/i.test(webUrl)) return "X (Twitter)";
  if (extractor) return extractor.replace(/(:.*|IE$)/i, "").trim() || "Web";
  return "Web";
}

function entryMusicMeta(entry: YtDlpEntry): YtDlpMusicMeta {
  return {
    categories: entry.categories,
    tags: entry.tags,
    track: entry.track,
    album: entry.album,
    album_artist: entry.album_artist,
    artist: entry.artist ?? entry.uploader ?? entry.channel,
    genre: entry.genre,
    title: entry.title,
    uploader: entry.uploader,
    channel: entry.channel,
    channel_id: entry.channel_id,
    is_live: entry.is_live,
    live_status: entry.live_status,
  };
}

function entryToSong(entry: YtDlpEntry): Song | null {
  const title = entry.title ?? "Unknown";
  const duration = Math.round(entry.duration ?? 0);
  // Full-album / non-music / over-long gates only for YouTube (not X/Bandcamp posts).
  const webUrl = entry.webpage_url ?? "";
  const isYt =
    /youtube|youtu\.be/i.test(entry.extractor ?? "") || /youtube\.com|youtu\.be/i.test(webUrl);
  // Prefer structured music artist when yt-dlp provides it.
  const artist =
    (typeof entry.artist === "string" && entry.artist.trim()) ||
    (typeof entry.album_artist === "string" && entry.album_artist.trim()) ||
    entry.uploader ||
    entry.channel ||
    "";
  const ytMeta = entryMusicMeta(entry);
  if (isYt && shouldBlockYoutubeSong({ title, artist, duration, ytMeta })) return null;
  const label = isYt ? "YouTube" : sourceLabelFor(webUrl, entry.extractor);
  // Prefer real album from music metadata over the "YouTube" platform label.
  const album =
    isYt && typeof entry.album === "string" && entry.album.trim() ? entry.album.trim() : label;
  return {
    // For non-YouTube (X/Twitter/…) keep the full page URL as the id — there's no
    // youtube-style ?v= id for getSongUrl to rebuild from, so it re-resolves the URL.
    id: isYt ? (entry.id ?? "") : webUrl || entry.id || "",
    name: (typeof entry.track === "string" && entry.track.trim()) || title,
    artist: artist || label,
    album,
    duration,
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
        // Full extract (not --flat-playlist) so categories / track / album / tags
        // are present for the non-music gate. Limit stays small for auto-DJ.
        raw = await runYtDlp(
          [`ytsearch${limit}:${query}`, "--dump-json", "--no-warnings", "--quiet", "--no-playlist"],
          45_000,
        );
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
