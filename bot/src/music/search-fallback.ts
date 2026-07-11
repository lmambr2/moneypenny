import { filterUnblockedSongs } from "./genre-block.js";
import type { MusicProvider, Song } from "./provider.js";

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
 * When set, we pull a slightly larger candidate list so we can skip blocked titles.
 */
export async function searchFirstWithFallback(
  primary: MusicProvider,
  query: string,
  limit: number,
  fallback?: MusicProvider,
  blockedGenres?: readonly string[] | null,
): Promise<{ provider: MusicProvider; song: Song } | null> {
  const fetchLimit = Math.max(
    limit,
    blockedGenres === undefined || (blockedGenres?.length ?? 0) > 0 ? 8 : 1,
  );
  const pick = (
    provider: MusicProvider,
    songs: Song[],
  ): { provider: MusicProvider; song: Song } | null => {
    const allowed = filterUnblockedSongs(songs, blockedGenres);
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
