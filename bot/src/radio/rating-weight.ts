/**
 * OQ7 — gentle rating-weighted draw for radio pool ordering.
 * Pure functions; TagStore.smoothedScore supplies scores.
 */
export interface RatingWeightOpts {
  enabled: boolean;
  /** Weight = score^exponent (default 1). */
  exponent?: number;
  /** Cap ratio between max and min positive weight (default 3). */
  maxRatio?: number;
}

/**
 * Order keys preferring higher scores when weighting is enabled.
 * Deterministic given the same `rng` seed sequence; default rng is Math.random.
 * When disabled or all scores equal, returns a shuffled copy (or stable if rng is fixed).
 */
export function orderKeysByRatingWeight(
  keys: string[],
  scoreOf: (key: string) => number,
  opts: RatingWeightOpts,
  rng: () => number = Math.random,
): string[] {
  if (keys.length <= 1) return keys.slice();
  if (!opts.enabled) return shuffleCopy(keys, rng);

  const exponent = opts.exponent ?? 1;
  const maxRatio = Math.max(1, opts.maxRatio ?? 3);
  const scores = keys.map((k) => Math.max(0, scoreOf(k)));
  let weights = scores.map((s) => Math.max(s, 0.01) ** exponent);
  const wMin = Math.min(...weights);
  const wMax = Math.max(...weights);
  if (wMax > wMin * maxRatio && wMin > 0) {
    // Compress so max/min ≤ maxRatio
    const scale = (wMin * maxRatio) / wMax;
    weights = weights.map((w) => (w === wMax ? w * scale : w));
    // Actually compress all above the cap relative to min
    weights = scores.map((s) => {
      const raw = Math.max(s, 0.01) ** exponent;
      return Math.min(raw, wMin * maxRatio);
    });
  }

  // Weighted random sample without replacement
  const remaining = keys.map((k, i) => ({ k, w: weights[i]! }));
  const out: string[] = [];
  while (remaining.length > 0) {
    const total = remaining.reduce((a, x) => a + x.w, 0);
    let r = rng() * total;
    let pick = 0;
    for (let i = 0; i < remaining.length; i++) {
      r -= remaining[i]!.w;
      if (r <= 0) {
        pick = i;
        break;
      }
      pick = i;
    }
    out.push(remaining[pick]!.k);
    remaining.splice(pick, 1);
  }
  return out;
}

function shuffleCopy<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
