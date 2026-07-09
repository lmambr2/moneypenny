import axios from "axios";
import { assertPublicPlaybackUrl, isPublicPlaybackUrl } from "./url-guard.js";
import type {
  MusicProvider,
  Song,
  Playlist,
  Album,
  SearchResult,
  LyricLine,

  AuthStatus,
} from "./provider.js";
import type { Logger } from "../logger.js";
import { errorMessage } from "../util/error.js";

/**
 * StreamProvider (DESIGN §7.3) — plays an arbitrary HTTP/Icecast stream URL.
 *
 * Any external player that exposes a local stream becomes a source. Two modes:
 *  1. Direct: a plain http(s) audio/stream URL is played as-is (ffmpeg handles
 *     containers + Icecast metadata).
 *  2. Bridged: a Spotify URI/URL is resolved through an external bridge
 *     (librespot/ncspot + Spotify Web API for metadata). The bridge contract is
 *     OUR OWN minimal HTTP shape — `GET {bridgeUrl}/resolve?uri=<ref>` →
 *     `{ streamUrl, title?, artist?, durationSec?, coverUrl? }` — reimplemented
 *     per §5, not copied from any GPL/OSL project.
 *
 * Song.id encodes how to recover a playable URL at play time:
 *  - direct URLs: the URL itself (stream URLs can be long-lived).
 *  - bridged refs: the original spotify ref, re-resolved on getSongUrl() so we
 *    always hand ffmpeg a fresh (possibly ephemeral) stream URL.
 */

const YOUTUBE_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
const XTWITTER_HOSTS = /(^|\.)(twitter\.com|x\.com|t\.co)$/i;
const BANDCAMP_HOSTS = /(^|\.)bandcamp\.com$/i;
const TIDAL_HOSTS = /(^|\.)(tidal\.com|listen\.tidal\.com)$/i;
const SPOTIFY_HOSTS = /(^|\.)(open\.spotify\.com|spotify\.com)$/i;

function hostMatches(input: string, re: RegExp): boolean {
  try {
    return re.test(new URL(input.trim()).hostname);
  } catch {
    return false;
  }
}

/** True for an X/Twitter URL — handled by the yt-dlp (YouTube) provider, not the stream one. */
export function isXTwitterUrl(input: string): boolean {
  return hostMatches(input, XTWITTER_HOSTS);
}

/** True for a Bandcamp URL — yt-dlp streams it natively (no DRM), via the yt-dlp provider. */
export function isBandcampUrl(input: string): boolean {
  return hostMatches(input, BANDCAMP_HOSTS);
}

/** True for a Tidal URL. DRM'd — resolved to a search query unless a bridge is configured. */
export function isTidalUrl(input: string): boolean {
  return hostMatches(input, TIDAL_HOSTS);
}

/**
 * True for a playable direct http(s) stream URL. Excludes the sites that have
 * their own handling: YouTube/X/Twitter/Bandcamp (yt-dlp) and Spotify/Tidal
 * (bridge or metadata→search) — so those don't get mis-played as raw streams.
 */
export function isStreamableUrl(input: string): boolean {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (!isPublicPlaybackUrl(input)) return false;
  const h = u.hostname;
  return (
    !YOUTUBE_HOSTS.test(h) && !XTWITTER_HOSTS.test(h) && !BANDCAMP_HOSTS.test(h) &&
    !TIDAL_HOSTS.test(h) && !SPOTIFY_HOSTS.test(h)
  );
}

/**
 * Resolve a DRM'd track link (Spotify/Tidal) to an "Artist Title" search query by
 * scraping its OpenGraph tags. Used to play the song from the local library or
 * YouTube when no streaming bridge is configured. Best-effort — null on failure.
 */
export async function resolveExternalTrackQuery(url: string, logger?: Logger): Promise<string | null> {
  if (!isPublicPlaybackUrl(url)) return null;
  try {
    const { data: html } = await axios.get<string>(url, {
      timeout: 10_000,
      responseType: "text",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Moneypenny/1.0)" },
    });
    const og = (prop: string): string | null => {
      const m =
        html.match(new RegExp(`<meta[^>]+(?:property|name)=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, "i")) ||
        html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:${prop}["']`, "i"));
      return m ? decodeHtmlEntities(m[1]) : null;
    };
    const title = og("title");
    if (!title) return null;
    // Spotify desc: "Artist · Song · 2023" · Tidal: "Artist — ..." → take a leading artist if distinct.
    const artist = (og("description") || "").split(/[·|—-]/)[0].trim();
    const q = artist && !title.toLowerCase().includes(artist.toLowerCase()) ? `${artist} ${title}` : title;
    logger?.debug({ url, q }, "Resolved external (Spotify/Tidal) track to a search query");
    return q;
  } catch (err: unknown) {
    logger?.warn({ err: errorMessage(err), url }, "Failed to resolve external track metadata");
    return null;
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#x27;/gi, "'");
}

export function isYouTubeUrl(input: string): boolean {
  try {
    const u = new URL(input.trim());
    return YOUTUBE_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

/** True for a Spotify track/playlist/album reference (uri or open.spotify.com URL). */
export function isSpotifyRef(input: string): boolean {
  const s = input.trim();
  if (/^spotify:(track|playlist|album):[A-Za-z0-9]+$/.test(s)) return true;
  try {
    return new URL(s).hostname.replace(/^www\./, "") === "open.spotify.com";
  } catch {
    return false;
  }
}

function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : u.hostname;
  } catch {
    return "Stream";
  }
}

interface BridgeResolved {
  streamUrl: string;
  title?: string;
  artist?: string;
  durationSec?: number;
  coverUrl?: string;
}

export interface StreamProviderOptions {
  /** Base URL of the Spotify/Tidal stream bridge. Empty → bridged refs unsupported. */
  bridgeUrl?: string;
  logger?: Logger;
  timeoutMs?: number;
}

export class StreamProvider implements MusicProvider {
  readonly platform = "stream" as const;
  private quality = "default";
  private bridgeUrl: string;
  private logger?: Logger;
  private timeoutMs: number;

  constructor(opts: StreamProviderOptions = {}) {
    this.bridgeUrl = (opts.bridgeUrl ?? "").replace(/\/$/, "");
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /** Hot-reload the Spotify/Tidal bridge base URL (Settings / env override). */
  setBridgeUrl(url: string): void {
    this.bridgeUrl = url.replace(/\/$/, "");
  }

  getBridgeUrl(): string {
    return this.bridgeUrl;
  }

  /** Whether this provider can handle `query` (direct URL, or a bridged Spotify/Tidal ref). */
  canHandle(query: string): boolean {
    return isStreamableUrl(query) || (!!this.bridgeUrl && (isSpotifyRef(query) || isTidalUrl(query)));
  }

  private async resolveBridge(ref: string): Promise<BridgeResolved | null> {
    if (!this.bridgeUrl) return null;
    try {
      const { data } = await axios.get<BridgeResolved>(`${this.bridgeUrl}/resolve`, {
        params: { uri: ref },
        timeout: this.timeoutMs,
      });
      if (!data?.streamUrl) return null;
      // Never feed ffmpeg a private/literal or DNS-rebinding SSRF target.
      if (!(await assertPublicPlaybackUrl(data.streamUrl))) {
        this.logger?.warn({ streamUrl: data.streamUrl.slice(0, 80) }, "Stream bridge returned non-public streamUrl — dropped");
        return null;
      }
      return data;
    } catch (err: unknown) {
      this.logger?.warn({ err: errorMessage(err), ref }, "Stream bridge resolve failed");
      return null;
    }
  }

  async search(query: string, _limit = 1): Promise<SearchResult> {
    const q = query.trim();
    if (isStreamableUrl(q)) {
      const song: Song = {
        id: q,
        name: nameFromUrl(q),
        artist: "Stream",
        album: "Stream",
        duration: 0,
        coverUrl: "",
        platform: "stream",
      };
      return { songs: [song], playlists: [], albums: [] };
    }
    if (this.bridgeUrl && (isSpotifyRef(q) || isTidalUrl(q))) {
      const meta = await this.resolveBridge(q);
      const svc = isTidalUrl(q) ? "Tidal" : "Spotify";
      const song: Song = {
        id: q, // keep the ref; re-resolve at play time
        name: meta?.title ?? `${svc} track`,
        artist: meta?.artist ?? svc,
        album: svc,
        duration: meta?.durationSec ?? 0,
        coverUrl: meta?.coverUrl ?? "",
        platform: "stream",
      };
      return { songs: [song], playlists: [], albums: [] };
    }
    return { songs: [], playlists: [], albums: [] };
  }

  async getSongUrl(songId: string): Promise<string | null> {
    // DNS rebinding defense: re-resolve hostname at play time (not only at search).
    if (isStreamableUrl(songId)) {
      if (!(await assertPublicPlaybackUrl(songId))) {
        this.logger?.warn(
          { url: songId.slice(0, 80) },
          "Stream URL failed public DNS check — refusing play",
        );
        return null;
      }
      return songId;
    }
    if (this.bridgeUrl && (isSpotifyRef(songId) || isTidalUrl(songId))) {
      const meta = await this.resolveBridge(songId);
      return meta?.streamUrl ?? null;
    }
    return null;
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    const result = await this.search(songId);
    return result.songs[0] ?? null;
  }

  setQuality(quality: string): void {
    this.quality = quality;
  }
  getQuality(): string {
    return this.quality;
  }

  /**
   * Expand a Spotify/Tidal playlist via the bridge (R-R6).
   * Contract: `GET {bridge}/playlist?uri=<ref>` →
   * `{ tracks: [{ uri|id, title?, artist?, durationSec?, coverUrl?, streamUrl? }] }`
   * Each track is returned as a stream Song (id = uri for re-resolve at play).
   */
  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    const ref = playlistId.trim();
    if (!this.bridgeUrl) return [];
    if (!isSpotifyRef(ref) && !isTidalUrl(ref) && !/^spotify:playlist:/i.test(ref)) {
      // Also accept bare open.spotify.com/playlist URLs already covered by isSpotifyRef
      if (!/playlist/i.test(ref)) return [];
    }
    try {
      const { data } = await axios.get<{
        tracks?: Array<{
          uri?: string;
          id?: string;
          title?: string;
          name?: string;
          artist?: string;
          durationSec?: number;
          coverUrl?: string;
          streamUrl?: string;
        }>;
        error?: string;
      }>(`${this.bridgeUrl}/playlist`, {
        params: { uri: ref },
        timeout: this.timeoutMs,
      });
      const tracks = data?.tracks;
      if (!Array.isArray(tracks) || tracks.length === 0) {
        if (data?.error) {
          this.logger?.warn({ err: data.error, ref }, "Stream bridge playlist empty/unavailable");
        }
        return [];
      }
      const svc = isTidalUrl(ref) ? "Tidal" : "Spotify";
      return tracks
        .map((t): Song | null => {
          const id = (t.uri || t.id || "").trim();
          if (!id) return null;
          return {
            id,
            name: t.title || t.name || `${svc} track`,
            artist: t.artist || svc,
            album: svc,
            duration: t.durationSec ?? 0,
            coverUrl: t.coverUrl ?? "",
            platform: "stream",
          };
        })
        .filter((s): s is Song => !!s);
    } catch (err: unknown) {
      this.logger?.warn({ err: errorMessage(err), ref }, "Stream bridge playlist failed");
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
    // "loggedIn" here = a Spotify/Tidal bridge is configured. Direct stream URLs
    // work regardless; the flag tells the UI whether bridged refs are usable.
    return this.bridgeUrl
      ? { loggedIn: true, nickname: "Stream bridge configured" }
      : { loggedIn: false, nickname: "Direct stream URLs only (no bridge)" };
  }
}
