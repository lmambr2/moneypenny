/**
 * Station content policy: block genres by substring match on title/artist/album
 * (and optional tagged genre fields). Used for !play/!add, radio seed pools, and
 * resolve-time skip so blocked tracks never reach the channel.
 */

/** Default ban list — rap / hip-hop / R&B family. Empty config uses this. */
export const DEFAULT_MUSIC_BLOCKED_GENRES = [
  "rap",
  "hip hop",
  "hip-hop",
  "hiphop",
  "r&b",
  "rnb",
  "r and b",
  "rhythm and blues",
] as const;

export type GenreBlockable = {
  name?: string;
  artist?: string;
  album?: string;
  /** Optional TagStore / embedded genre strings */
  genre?: string | string[] | null;
  subgenre?: string | string[] | null;
};

/**
 * Normalize a config list. `null`/`undefined` → station defaults (rap/hip-hop/R&B).
 * Explicit empty array → no blocking. Trims, lowercases, drops empties.
 */
export function normalizeMusicBlockedGenres(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return [...DEFAULT_MUSIC_BLOCKED_GENRES];
  }
  if (!Array.isArray(raw)) {
    return [...DEFAULT_MUSIC_BLOCKED_GENRES];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const t = item.trim().toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function fieldBlob(v: string | string[] | null | undefined): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join(" ");
  return String(v);
}

/** Haystack: name/artist/album/genre/subgenre, lowercased. */
export function songGenreHaystack(song: GenreBlockable): string {
  return [
    song.name ?? "",
    song.artist ?? "",
    song.album ?? "",
    fieldBlob(song.genre),
    fieldBlob(song.subgenre),
  ]
    .join(" ")
    .toLowerCase()
    .replace(/[_/]+/g, " ");
}

/**
 * "Lofi hip hop" / chillhop is instrumental study music, not the rap family we
 * ban. When the only match is a hip-hop term inside a lofi/chillhop title, allow it.
 * Rap / R&B terms still block even with "lofi" in the string.
 */
const LOFI_CHILL_CONTEXT_RE =
  /\b(lo[\s-]?fi|chillhop|chill\s*hop|study\s+beats|beats\s+to\s+(study|relax|chill|work))\b/i;
const HIPHOP_FAMILY_TERMS = new Set(["hip hop", "hip-hop", "hiphop"]);

function isHipHopFamilyTerm(term: string): boolean {
  return HIPHOP_FAMILY_TERMS.has(term.trim().toLowerCase());
}

/**
 * Match blocked terms as whole-ish tokens so "rap" does not hit "trap" wait -
 * actually "trap" contains no "rap" as word... "crap" would match \brap\b? "scrap" has rap.
 * Use word-boundary style for short terms; substring for multi-word ("hip hop").
 */
export function textMatchesBlockedGenre(haystack: string, terms: readonly string[]): boolean {
  if (!terms.length || !haystack) return false;
  const h = haystack.toLowerCase();
  const lofiContext = LOFI_CHILL_CONTEXT_RE.test(h);
  for (const term of terms) {
    const t = term.trim().toLowerCase();
    if (!t) continue;
    let matched = false;
    if (t.includes(" ") || t.includes("-") || t.includes("&")) {
      // Multi-token / punctuated: flexible space/punct between parts
      const parts = t.split(/[\s\-&]+/).filter(Boolean);
      if (parts.length === 0) continue;
      const re = new RegExp(`\\b${parts.map(escapeRe).join("[\\s\\-&]*")}\\b`, "i");
      if (re.test(h)) matched = true;
      // Also plain includes for "r&b" style after normalize
      else if (h.includes(t.replace(/\s+/g, " "))) matched = true;
    } else {
      // Single token: word boundary so "rap" ≠ "scrape" mid-word oddly — still
      // "trap" is fine; avoid matching inside longer alpha tokens.
      const re = new RegExp(`\\b${escapeRe(t)}\\b`, "i");
      if (re.test(h)) matched = true;
    }
    if (!matched) continue;
    // Lofi/chillhop titles almost always say "hip hop" — that's not rap for our station.
    if (lofiContext && isHipHopFamilyTerm(t)) continue;
    return true;
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isBlockedGenreSong(
  song: GenreBlockable,
  blockedGenres?: readonly string[] | null,
): boolean {
  const list = normalizeMusicBlockedGenres(
    blockedGenres === undefined ? undefined : blockedGenres === null ? null : [...blockedGenres],
  );
  if (list.length === 0) return false;
  return textMatchesBlockedGenre(songGenreHaystack(song), list);
}

export function filterUnblockedSongs<T extends GenreBlockable>(
  songs: T[],
  blockedGenres?: readonly string[] | null,
): T[] {
  const list = normalizeMusicBlockedGenres(
    blockedGenres === undefined ? undefined : blockedGenres === null ? null : [...blockedGenres],
  );
  if (list.length === 0) return songs;
  return songs.filter((s) => !textMatchesBlockedGenre(songGenreHaystack(s), list));
}

/** Human reason for command replies. */
export function blockedGenreMessage(song: GenreBlockable): string {
  const label = [song.name, song.artist].filter(Boolean).join(" — ") || "that track";
  return `Blocked by station genre policy (rap / hip-hop / R&B family): ${label}`;
}
