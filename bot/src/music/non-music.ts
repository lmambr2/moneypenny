/**
 * Station content policy: keep auto-DJ / YouTube on actual music.
 *
 * Primary signal: **yt-dlp metadata** (YouTube `categories`, music tags like
 * `track`/`album`/`album_artist`, and tag list). Title heuristics are a
 * fallback when flat/oEmbed results omit categories — not the main gate.
 */

export type NonMusicCheckable = {
  name?: string | null;
  artist?: string | null;
  album?: string | null;
  title?: string | null;
};

/** Subset of yt-dlp info-json used for music vs non-music classification. */
export type YtDlpMusicMeta = {
  categories?: string[] | string | null;
  tags?: string[] | string | null;
  /** Structured music fields (YouTube Music / MusicBrainz-style). */
  track?: string | null;
  album?: string | null;
  album_artist?: string | null;
  artist?: string | null;
  genre?: string | null;
  title?: string | null;
  uploader?: string | null;
  channel?: string | null;
  channel_id?: string | null;
};

export type MusicMetaVerdict = "music" | "nonmusic" | "unknown";

function asStringList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) {
    return v
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

/** YouTube categories that are almost never station music. */
const NON_MUSIC_CATEGORIES = new Set([
  "news & politics",
  "education",
  "gaming",
  "howto & style",
  "science & technology",
  "pets & animals",
  "autos & vehicles",
  "nonprofits & activism",
  "travel & events",
  "sports",
]);

/**
 * Classify from yt-dlp info-json alone.
 * - `music`: categories include Music, or structured track/album fields, or music tags
 * - `nonmusic`: categories are explicitly non-music (News, Education, Gaming, …)
 * - `unknown`: no usable category/music fields (title fallback applies)
 */
export function classifyYtDlpMusicMeta(meta: YtDlpMusicMeta | null | undefined): MusicMetaVerdict {
  if (!meta) return "unknown";

  // Structured music metadata → strong music signal (YTM / tagged uploads).
  if (
    (typeof meta.track === "string" && meta.track.trim()) ||
    (typeof meta.album_artist === "string" && meta.album_artist.trim()) ||
    (typeof meta.album === "string" &&
      meta.album.trim() &&
      ((typeof meta.artist === "string" && meta.artist.trim()) ||
        (typeof meta.album_artist === "string" && meta.album_artist.trim())))
  ) {
    return "music";
  }

  const cats = asStringList(meta.categories).map((c) => c.toLowerCase());
  if (cats.length > 0) {
    if (cats.some((c) => c === "music" || c.includes("music"))) return "music";
    if (cats.some((c) => NON_MUSIC_CATEGORIES.has(c))) return "nonmusic";
    // Film & Animation / Entertainment / People & Blogs / Comedy — ambiguous
  }

  const tags = asStringList(meta.tags).map((t) => t.toLowerCase());
  if (tags.length > 0) {
    if (
      tags.some(
        (t) =>
          t === "music" ||
          t === "song" ||
          t === "official music video" ||
          t === "music video" ||
          t === "official audio" ||
          t.startsWith("genre:") ||
          t.includes("hip hop") ||
          t.includes("rock music") ||
          t.includes("pop music"),
      )
    ) {
      return "music";
    }
    if (
      tags.some(
        (t) =>
          t.includes("documentary") ||
          t === "podcast" ||
          t.includes("true crime") ||
          t.includes("news") ||
          t === "trailer" ||
          t.includes("full movie"),
      )
    ) {
      return "nonmusic";
    }
  }

  const genre = typeof meta.genre === "string" ? meta.genre.toLowerCase() : "";
  if (genre) {
    if (/\b(documentary|podcast|audiobook|news|speech|comedy special)\b/i.test(genre)) {
      return "nonmusic";
    }
    // Any other non-empty genre is a mild music signal
    return "music";
  }

  return "unknown";
}

/** Normalize for keyword matching (fallback when metadata is unknown). */
export function nonMusicHaystack(song: NonMusicCheckable): string {
  return [song.name ?? song.title ?? "", song.artist ?? "", song.album ?? ""]
    .join(" ")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s._'&-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MUSIC_ALLOW_RE =
  /\b(official\s+(audio|video|mv|music\s+video)|lyrics?|lyric\s+video|music\s+video|\bmv\b|ost\b|soundtrack|theme\s+song|instrumental|cover\s+by|live\s+(at|from|in)|concert|session|single|ep\b|album\s+version|remaster|visualizer)\b/i;

/** Slim hard title fallback — only clear non-music phrases (metadata does the heavy lifting). */
const HARD_TITLE_NON_MUSIC: RegExp[] = [
  /\bdocumentar(?:y|ies)\b/i,
  /\bdocuseries\b/i,
  /\bfull\s+movie\b/i,
  /\bofficial\s+trailer\b/i,
  /\bteaser\s+trailer\b/i,
  /\bpodcast\b/i,
  /\baudiobook\b/i,
  /\btrue\s+crime\b/i,
  /\bbreaking\s+news\b/i,
  /\bgameplay\b/i,
  /\blet'?s\s+play\b/i,
  /\bted\s+talks?\b/i,
  /\bfull\s+episode\b/i,
  // TV / web series / numbered episodes (e.g. "Yacht Rock Episode 1") — not tracks.
  /\bepisode\s*#?\s*\d+/i,
  /\bep\.?\s*#?\s*\d+\b/i,
  /\bseason\s*#?\s*\d+/i,
  /\bs\d{1,2}\s*e\d{1,3}\b/i,
  /\bminiseries\b/i,
  /\bweb\s*series\b/i,
  /\b(series|show)\s+premiere\b/i,
  /\bpilot\s+episode\b/i,
  /\bstand[\s-]?up\s+comedy\b/i,
  /\bcomedy\s+special\b/i,
  /\bfull\s+interview\b/i,
  /\bguided\s+meditat(?:ion|e)\b/i,
  /\basmr\b/i,
];

/**
 * Title-only fallback when yt-dlp didn't give categories/track fields
 * (oEmbed, sparse flat results). Prefer {@link shouldBlockAsNonMusic} with meta.
 */
export function isNonMusicContent(song: NonMusicCheckable): boolean {
  const hay = nonMusicHaystack(song);
  if (!hay) return false;
  if (MUSIC_ALLOW_RE.test(hay)) return false;
  for (const re of HARD_TITLE_NON_MUSIC) {
    if (re.test(hay)) return true;
  }
  return false;
}

/**
 * Full gate: yt-dlp metadata first, title fallback only when unknown.
 * When meta says `music`, title soft junk is ignored (still block hard
 * "full movie"/"podcast" titles that were mis-tagged as Music).
 */
export function shouldBlockAsNonMusic(
  song: NonMusicCheckable,
  meta?: YtDlpMusicMeta | null,
): boolean {
  const verdict = classifyYtDlpMusicMeta(meta);
  if (verdict === "nonmusic") return true;
  if (verdict === "music") {
    // Mis-categorized uploads still show clear non-music titles.
    const hay = nonMusicHaystack(song);
    for (const re of HARD_TITLE_NON_MUSIC) {
      if (re.test(hay)) return true;
    }
    return false;
  }
  return isNonMusicContent(song);
}

export function nonMusicBlockMessage(song: NonMusicCheckable): string {
  const label = [song.name ?? song.title, song.artist].filter(Boolean).join(" — ") || "that track";
  return `Blocked non-music content: ${label}`;
}
