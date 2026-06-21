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
 */
export async function searchFirstWithFallback(
  primary: MusicProvider,
  query: string,
  limit: number,
  fallback?: MusicProvider,
): Promise<{ provider: MusicProvider; song: Song } | null> {
  let result = await primary.search(query, limit);
  let chosen = primary;
  if (result.songs.length === 0 && fallback) {
    const fb = await fallback.search(query, limit);
    if (fb.songs.length > 0) {
      result = fb;
      chosen = fallback;
    }
  }
  if (result.songs.length === 0) return null;
  return { provider: chosen, song: result.songs[0] };
}
