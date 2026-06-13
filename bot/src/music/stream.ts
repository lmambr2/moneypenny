import axios from "axios";
import type {
  MusicProvider,
  Song,
  Playlist,
  Album,
  SearchResult,
  LyricLine,
  QrCodeResult,
  AuthStatus,
} from "./provider.js";
import type { Logger } from "../logger.js";

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

/** True for a playable non-YouTube http(s) stream URL (YouTube has its own provider). */
export function isStreamableUrl(input: string): boolean {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return !YOUTUBE_HOSTS.test(u.hostname);
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

  /** Whether this provider can handle `query` (direct URL or bridged Spotify ref). */
  canHandle(query: string): boolean {
    return isStreamableUrl(query) || (!!this.bridgeUrl && isSpotifyRef(query));
  }

  private async resolveBridge(ref: string): Promise<BridgeResolved | null> {
    if (!this.bridgeUrl) return null;
    try {
      const { data } = await axios.get<BridgeResolved>(`${this.bridgeUrl}/resolve`, {
        params: { uri: ref },
        timeout: this.timeoutMs,
      });
      return data?.streamUrl ? data : null;
    } catch (err: any) {
      this.logger?.warn({ err: err?.message, ref }, "Stream bridge resolve failed");
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
    if (this.bridgeUrl && isSpotifyRef(q)) {
      const meta = await this.resolveBridge(q);
      const song: Song = {
        id: q, // keep the spotify ref; re-resolve at play time
        name: meta?.title ?? "Spotify track",
        artist: meta?.artist ?? "Spotify",
        album: "Spotify",
        duration: meta?.durationSec ?? 0,
        coverUrl: meta?.coverUrl ?? "",
        platform: "stream",
      };
      return { songs: [song], playlists: [], albums: [] };
    }
    return { songs: [], playlists: [], albums: [] };
  }

  async getSongUrl(songId: string): Promise<string | null> {
    if (isStreamableUrl(songId)) return songId;
    if (this.bridgeUrl && isSpotifyRef(songId)) {
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

  // Streams have no library/playlist/lyrics/auth concepts — return empties.
  async getPlaylistSongs(_playlistId: string): Promise<Song[]> {
    return [];
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
  async getQrCode(): Promise<QrCodeResult> {
    return { qrUrl: "", key: "" };
  }
  async checkQrCodeStatus(): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    return "expired";
  }
  setCookie(_cookie: string): void {}
  getCookie(): string {
    return "";
  }
  async getAuthStatus(): Promise<AuthStatus> {
    // "loggedIn" here = a Spotify/Tidal bridge is configured. Direct stream URLs
    // work regardless; the flag tells the UI whether bridged refs are usable.
    return this.bridgeUrl
      ? { loggedIn: true, nickname: "Stream bridge configured" }
      : { loggedIn: false, nickname: "Direct stream URLs only (no bridge)" };
  }
}
