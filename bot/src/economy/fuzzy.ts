/**
 * E-FUZZY — small deterministic fuzzy match for economy names.
 * SuperCargo-style idea (typos / confusable glyphs) without OCR pipeline.
 */

/** Normalize for comparison: lower, strip punctuation, collapse space. */
export function fuzzyNormalize(s: string): string {
  return foldConfusable(String(s || ""))
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compact alnum-only form (for code-like ids). */
export function fuzzyCompact(s: string): string {
  return fuzzyNormalize(s).replace(/\s+/g, "");
}

/**
 * Fold common confusable / OCR-ish pairs and SC spelling variants.
 * Applied before compare so "quantanium" ≈ "quantainium".
 */
export function foldConfusable(s: string): string {
  let out = String(s || "");
  // SC commodity spelling variants
  out = out.replace(/quantanium/gi, "quantainium");
  out = out.replace(/\b0\b/g, "o"); // lone zero as O (rare)
  return out;
}

/** Classic Levenshtein distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length;
  const n = b.length;
  // Single-row DP
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n] ?? 0;
}

/** Similarity 0..1 from Levenshtein (1 = identical). */
export function similarity(a: string, b: string): number {
  const na = fuzzyNormalize(a);
  const nb = fuzzyNormalize(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ca = fuzzyCompact(a);
  const cb = fuzzyCompact(b);
  if (ca === cb) return 1;
  const dist = levenshtein(ca, cb);
  const maxLen = Math.max(ca.length, cb.length);
  if (maxLen === 0) return 1;
  return Math.max(0, 1 - dist / maxLen);
}

export interface FuzzyScoreOpts {
  /** Minimum query length before fuzzy kicks in (default 3). */
  minQueryLen?: number;
}

/**
 * Score 0–100 how well `query` matches `candidate` (and optional aliases).
 * Aligns roughly with sc-craft scoreBlueprintMatch scale.
 */
export function fuzzyScore(
  query: string,
  candidate: string,
  aliases: string[] = [],
  opts: FuzzyScoreOpts = {},
): number {
  const minLen = opts.minQueryLen ?? 3;
  const qn = fuzzyNormalize(query);
  const qc = fuzzyCompact(query);
  if (!qn || qn.length < minLen) {
    // Still allow exact/prefix on short queries
    const names = [candidate, ...aliases];
    for (const name of names) {
      const nn = fuzzyNormalize(name);
      const nc = fuzzyCompact(name);
      if (nn === qn || nc === qc) return 100;
      if (nn.startsWith(qn) || nc.startsWith(qc)) return 80;
    }
    return 0;
  }

  let best = 0;
  const names = [candidate, ...aliases];
  for (const name of names) {
    const nn = fuzzyNormalize(name);
    const nc = fuzzyCompact(name);
    if (!nn) continue;
    if (nn === qn || nc === qc) return 100;
    if (nn.startsWith(qn) || nc.startsWith(qc)) best = Math.max(best, 85);
    else if (nn.includes(qn) || nc.includes(qc)) best = Math.max(best, 70);
    else {
      const sim = similarity(query, name);
      if (sim >= 0.92) best = Math.max(best, 75);
      else if (sim >= 0.84) best = Math.max(best, 55);
      else if (sim >= 0.75) best = Math.max(best, 40);
      else if (sim >= 0.65) best = Math.max(best, 25);
    }
    // multi-token: all query tokens present in name
    const tokens = qn.split(" ").filter(Boolean);
    if (tokens.length > 1 && tokens.every((t) => nn.includes(t) || nc.includes(t))) {
      best = Math.max(best, 50);
    }
  }
  return best;
}

export interface FuzzyMatch<T> {
  item: T;
  score: number;
}

/**
 * Rank items by fuzzy score against query. Highest first; drops score 0.
 */
export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  getNames: (item: T) => string | string[],
  opts: FuzzyScoreOpts & { limit?: number } = {},
): FuzzyMatch<T>[] {
  const out: FuzzyMatch<T>[] = [];
  for (const item of items) {
    const names = getNames(item);
    const list = Array.isArray(names) ? names : [names];
    const primary = list[0] ?? "";
    const aliases = list.slice(1);
    const score = fuzzyScore(query, primary, aliases, opts);
    if (score > 0) out.push({ item, score });
  }
  out.sort((a, b) => b.score - a.score);
  if (opts.limit != null && opts.limit > 0) return out.slice(0, opts.limit);
  return out;
}

/**
 * Best fuzzy match, or undefined if below minScore (default 40).
 */
export function fuzzyBestMatch<T>(
  query: string,
  items: readonly T[],
  getNames: (item: T) => string | string[],
  opts: FuzzyScoreOpts & { minScore?: number } = {},
): T | undefined {
  const minScore = opts.minScore ?? 40;
  const ranked = fuzzyRank(query, items, getNames, opts);
  const top = ranked[0];
  if (!top || top.score < minScore) return undefined;
  return top.item;
}
