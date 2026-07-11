import { filterUnblockedSongs } from "./genre-block.js";
import { isNonMusicContent } from "./non-music.js";
import type { PlaybackBlacklist } from "./playback-blacklist.js";
import { filterNotBlacklisted } from "./playback-blacklist.js";
import type { MusicProvider, Song } from "./provider.js";
import { shouldBlockYoutubeSong } from "./youtube.js";
// YT songs are already filtered in YouTubeProvider.entryToSong (yt-dlp meta).
// Title fallback here catches anything still in the candidate list.

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
  const fetchLimit = Math.max(limit, genreActive || blActive ? 8 : 1);
  const pick = (
    provider: MusicProvider,
    songs: Song[],
  ): { provider: MusicProvider; song: Song } | null => {
    const allowed = filterNotBlacklisted(
      filterUnblockedSongs(songs, blockedGenres),
      blacklist,
    ).filter((s) => {
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
    if (allowed.length === 0) return null;
    return { provider, song: allowed[0]! };
  };

  const result = await primary.search(query, fetchLimit);
  let hit = pick(primary, result.songs ?? []);
  if (hit) return hit;

  if (fallback) {
    const fb = await fallback.search(query, fetchLimit);
    hit = pick(fallback, fb.songs ?? []);
    if (hit) return hit;
  }
  return null;
}
