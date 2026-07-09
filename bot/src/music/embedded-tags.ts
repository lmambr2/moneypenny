/**
 * Seed TagStore from embedded file metadata (docs/radio.md §9.1 / R-R2).
 * Pure helpers so LocalProvider + tests share one mapping path.
 * Upsert uses source "embedded" — never clobbers analyzer/api/manual.
 */
import type { TrackTags } from "../radio/tag-store.js";

/** Minimal common-tag shape from music-metadata (and test fakes). */
export interface EmbeddedCommon {
  genre?: string[];
  bpm?: number;
  key?: string;
  mood?: string | string[];
  comment?: { text?: string }[] | string;
}

/**
 * Map music-metadata `common` fields into TagStore selection tags.
 * Returns only defined fields; empty object when nothing useful is present.
 */
export function tagsFromEmbeddedCommon(
  common: EmbeddedCommon | null | undefined,
): Partial<TrackTags> {
  if (!common) return {};
  const out: Partial<TrackTags> = {};

  const genre = firstString(common.genre);
  if (genre) out.genre = cleanToken(genre);

  if (typeof common.bpm === "number" && Number.isFinite(common.bpm) && common.bpm > 0) {
    out.bpm = Math.round(common.bpm);
  }

  const keyRaw = typeof common.key === "string" ? common.key.trim() : "";
  if (keyRaw) {
    const parsed = parseKeyScale(keyRaw);
    if (parsed.musicalKey) out.musicalKey = parsed.musicalKey;
    if (parsed.keyScale) out.keyScale = parsed.keyScale;
  }

  const mood = firstString(
    Array.isArray(common.mood) ? common.mood : common.mood ? [common.mood] : undefined,
  );
  if (mood) out.mood = cleanToken(mood);

  // Drop empty strings
  for (const k of Object.keys(out) as (keyof TrackTags)[]) {
    const v = out[k];
    if (v === "" || v === undefined) delete out[k];
  }
  return out;
}

function firstString(vals?: string[]): string | undefined {
  if (!vals?.length) return undefined;
  for (const v of vals) {
    const t = typeof v === "string" ? v.trim() : "";
    if (t) return t;
  }
  return undefined;
}

function cleanToken(s: string): string {
  return s.trim().slice(0, 64);
}

/** "Am", "A minor", "C#m", "F major" → musicalKey + keyScale. */
export function parseKeyScale(raw: string): { musicalKey?: string; keyScale?: string } {
  const s = raw.trim();
  if (!s) return {};
  const lower = s.toLowerCase();
  let keyScale: string | undefined;
  if (/\b(min|minor|m)\b/.test(lower) || /m$/.test(s.replace(/\s+/g, ""))) {
    keyScale = "minor";
  } else if (/\b(maj|major)\b/.test(lower)) {
    keyScale = "major";
  }
  // Strip scale words for the root
  const root = s
    .replace(/\s*(major|minor|maj|min)\s*/gi, "")
    .replace(/m$/i, "")
    .trim();
  // Keep A-G with optional #/b
  const m = root.match(/^([A-Ga-g])([#b♯♭]?)/);
  if (!m) return keyScale ? { keyScale } : {};
  const letter = m[1]!.toUpperCase();
  const acc = m[2] === "♯" ? "#" : m[2] === "♭" ? "b" : m[2] || "";
  return { musicalKey: `${letter}${acc}`, keyScale };
}
