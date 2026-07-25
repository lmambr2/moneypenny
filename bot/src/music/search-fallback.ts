import { filterUnblockedSongs } from "./genre-block.js";
import { isNonMusicContent } from "./non-music.js";
import type { PlaybackBlacklist } from "./playback-blacklist.js";
import { filterNotBlacklisted } from "./playback-blacklist.js";
import type { MusicProvider, Song } from "./provider.js";
import { shouldBlockYoutubeSong, YOUTUBE_MAX_DURATION_SEC } from "./youtube.js";

function isExplicitMediaUrl(query: string): boolean {
  return /^https?:\/\//i.test(query.trim());
}

// YT songs are already filtered in YouTubeProvider.entryToSong (yt-dlp meta).
// Title fallback here catches anything still in the candidate list.

/** Prefer real track lengths over multi-hour ambience dumps that dominate genre search. */
const PREFERRED_DURATION_MIN_SEC = 45;
const PREFERRED_DURATION_MAX_SEC = 10 * 60;

/**
 * When bare genre queries ("jazz", "lo-fi") return only multi-hour mixes / live
 * radios, retry with song-biased suffixes so !play still finds a discrete track.
 */
export function refinedPlayQueries(query: string): string[] {
  const q = query.trim();
  if (!q) return [];
  // URLs / already refined — don't loop.
  if (/^https?:\/\//i.test(q) || /\bofficial\s+audio\b/i.test(q)) return [];
  // Short / specific queries (artist + title) rarely need help.
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length >= 4) return [`${q} official audio`];
  return [`${q} official audio`, `${q} song`, `${q} topic`];
}

/** Lower is better. Prefer 45s–10m tracks; allow up to YT max; unknown last. */
export function playCandidateRank(song: Song): number {
  const d = Number(song.duration);
  if (Number.isFinite(d) && d >= PREFERRED_DURATION_MIN_SEC && d <= PREFERRED_DURATION_MAX_SEC) {
    return 0;
  }
  if (Number.isFinite(d) && d > 0 && d <= YOUTUBE_MAX_DURATION_SEC) return 1;
  if (!Number.isFinite(d) || d <= 0) return 2;
  return 3;
}

/**
 * Search `primary` for the first hit; if it returns nothing AND a `fallback`
 * provider is supplied, transparently retry there. This is what makes a bare
 * `!play <terms>` work against an empty local library — the caller passes the
 * YouTube provider as `fallback` only when the primary was the (default) local
 * provider and no explicit `-l` flag forced local-only. Returns the matched song
 * together with the provider that produced it (its platform must be used when
 * enqueuing), or null if nothing matched anywhere.
 *
 * Extracted from BotInstance.searchFirst as a pure function so the fallback
 * behavior is unit-testable without standing up a full bot.
 *
 * `blockedGenres` (station policy) drops rap/hip-hop/R&B-family hits before pick.
 * `blacklist` drops admin-banned track ids. When either is active we pull a
 * slightly larger candidate list so we can skip blocked titles.
 *
 * Genre / vibe queries often surface multi-hour YouTube ambience that our
 * duration + livestream filters reject. We fetch a wider page and, if still
 * empty, retry song-biased refinements ("official audio", "song", "topic").
 */
export async function searchFirstWithFallback(
  primary: MusicProvider,
  query: string,
  limit: number,
  fallback?: MusicProvider,
  blockedGenres?: readonly string[] | null,
  blacklist?: PlaybackBlacklist | null,
): Promise<{ provider: MusicProvider; song: Song } | null> {
  const genreActive = blockedGenres === undefined || (blockedGenres?.length ?? 0) > 0;
  const blActive = !!blacklist;
  // Wide page: genre filters + YT dump filters burn through top hits quickly.
  const fetchLimit = Math.max(limit, genreActive || blActive ? 16 : 8, 12);

  const pick = (
    provider: MusicProvider,
    songs: Song[],
    /** Pasted media URL — content/genre gates off; ban list still applies. */
    explicitUrl: boolean,
  ): { provider: MusicProvider; song: Song } | null => {
    // Explicit paste: user named this URL — play it (only admin blacklist can stop it).
    const candidates = explicitUrl
      ? filterNotBlacklisted(songs, blacklist)
      : filterNotBlacklisted(filterUnblockedSongs(songs, blockedGenres), blacklist).filter((s) => {
          if (isNonMusicContent(s)) return false;
          if (
            s.platform === "youtube" &&
            shouldBlockYoutubeSong({
              title: s.name,
              artist: s.artist,
              album: s.album,
              duration: s.duration,
            })
          ) {
            return false;
          }
          return true;
        });
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => playCandidateRank(a) - playCandidateRank(b));
    return { provider, song: candidates[0]! };
  };

  const tryQuery = async (q: string): Promise<{ provider: MusicProvider; song: Song } | null> => {
    const explicit = isExplicitMediaUrl(q);
    const result = await primary.search(q, fetchLimit);
    let hit = pick(primary, result.songs ?? [], explicit);
    if (hit) return hit;

    if (fallback) {
      const fb = await fallback.search(q, fetchLimit);
      hit = pick(fallback, fb.songs ?? [], explicit);
      if (hit) return hit;
    }
    return null;
  };

  const first = await tryQuery(query);
  if (first) return first;

  // Bare genre terms ("jazz", "lo-fi") → only multi-hour mixes. Dig for songs.
  for (const refined of refinedPlayQueries(query)) {
    const hit = await tryQuery(refined);
    if (hit) return hit;
  }
  return null;
}
