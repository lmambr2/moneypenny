/**
 * OQ5 — Camelot-style harmonic ordering of a music pool window.
 * Pure: reorder track keys given musicalKey + keyScale lookup.
 * https://mixedinkey.com/harmonic-mixing-guide/ (Camelot wheel)
 */

/** Camelot code "1A".."12A" (minor) / "1B".."12B" (major). */
const MAJOR_ROOTS = ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"] as const;
// Camelot major B: 8B=C, 9B=G, 10B=D, 11B=A, 12B=E, 1B=B, 2B=F#, 3B=Db, 4B=Ab, 5B=Eb, 6B=Bb, 7B=F
const MAJOR_CAMELOT: Record<string, string> = {
  C: "8B",
  G: "9B",
  D: "10B",
  A: "11B",
  E: "12B",
  B: "1B",
  "F#": "2B",
  Gb: "2B",
  Db: "3B",
  "C#": "3B",
  Ab: "4B",
  "G#": "4B",
  Eb: "5B",
  "D#": "5B",
  Bb: "6B",
  "A#": "6B",
  F: "7B",
};

// Camelot minor A: relative minors — A=8A, E=9A, B=10A, F#=11A, C#=12A, G#=1A, D#=2A, A#=3A, F=4A, C=5A, G=6A, D=7A
const MINOR_CAMELOT: Record<string, string> = {
  A: "8A",
  E: "9A",
  B: "10A",
  "F#": "11A",
  Gb: "11A",
  "C#": "12A",
  Db: "12A",
  "G#": "1A",
  Ab: "1A",
  "D#": "2A",
  Eb: "2A",
  "A#": "3A",
  Bb: "3A",
  F: "4A",
  C: "5A",
  G: "6A",
  D: "7A",
};

export function toCamelot(musicalKey?: string, keyScale?: string): string | null {
  if (!musicalKey) return null;
  const root = normalizeRoot(musicalKey);
  if (!root) return null;
  const minor =
    keyScale?.toLowerCase() === "minor" ||
    keyScale?.toLowerCase() === "min" ||
    keyScale?.toLowerCase() === "m";
  const table = minor ? MINOR_CAMELOT : MAJOR_CAMELOT;
  return table[root] ?? null;
}

function normalizeRoot(k: string): string | null {
  const m = k.trim().match(/^([A-Ga-g])([#b♯♭]?)/);
  if (!m) return null;
  const letter = m[1]!.toUpperCase();
  const acc = m[2] === "♯" ? "#" : m[2] === "♭" ? "b" : m[2] || "";
  // Enharmonic normalize a few
  if (letter === "A" && acc === "#") return "Bb";
  if (letter === "D" && acc === "#") return "Eb";
  if (letter === "G" && acc === "#") return "Ab";
  return `${letter}${acc}`;
}

/** Adjacent Camelot codes: same number flip A/B, ±1 same letter. */
export function camelotCompatible(a: string, b: string): boolean {
  if (a === b) return true;
  const ma = a.match(/^(\d{1,2})([AB])$/i);
  const mb = b.match(/^(\d{1,2})([AB])$/i);
  if (!ma || !mb) return false;
  const na = Number(ma[1]);
  const nb = Number(mb[1]);
  const la = ma[2]!.toUpperCase();
  const lb = mb[2]!.toUpperCase();
  if (na === nb && la !== lb) return true; // relative major/minor
  if (la === lb) {
    const diff = Math.min(Math.abs(na - nb), 12 - Math.abs(na - nb));
    return diff === 1;
  }
  return false;
}

export interface HarmonicTrackMeta {
  musicalKey?: string;
  keyScale?: string;
}

/**
 * Greedy nearest-neighbor order starting from the first track that has a key
 * (or keys[0] if none). Tracks without keys trail at the end in original order.
 */
export function orderKeysHarmonically(
  keys: string[],
  metaOf: (key: string) => HarmonicTrackMeta | null | undefined,
  enabled: boolean,
): string[] {
  if (!enabled || keys.length <= 1) return keys.slice();

  const withCode: { k: string; code: string }[] = [];
  const noKey: string[] = [];
  for (const k of keys) {
    const meta = metaOf(k);
    const code = toCamelot(meta?.musicalKey, meta?.keyScale);
    if (code) withCode.push({ k, code });
    else noKey.push(k);
  }
  if (withCode.length <= 1) return keys.slice();

  const ordered: string[] = [];
  const remaining = withCode.slice();
  // Start with first keyed track in original order
  ordered.push(remaining.shift()!.k);
  while (remaining.length > 0) {
    const lastCode = toCamelot(
      metaOf(ordered[ordered.length - 1]!)?.musicalKey,
      metaOf(ordered[ordered.length - 1]!)?.keyScale,
    )!;
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]!.code;
      const score = camelotCompatible(lastCode, c)
        ? 2
        : c[c.length - 1] === lastCode[lastCode.length - 1]
          ? 1
          : 0;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    ordered.push(remaining.splice(bestIdx, 1)[0]!.k);
  }
  return [...ordered, ...noKey];
}

// silence unused MAJOR_ROOTS lint if any
void MAJOR_ROOTS;
