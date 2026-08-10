/**
 * Smart rotation — pure pool-ordering helpers for Auto-DJ (docs/radio.md).
 *
 * Pipeline (after auto-DJ repeat filter):
 *   separation → rating weight → energy bias → harmonic
 *
 * RadioDirector / bumper system are untouched. When policies are disabled
 * (or meta is missing), each step is identity so radio-off paths stay unused
 * and radio-on with everything off matches prior ordering minus RNG.
 */

import { orderKeysHarmonically, type HarmonicTrackMeta } from "./harmonic.js";
import { orderKeysByRatingWeight, type RatingWeightOpts } from "./rating-weight.js";

/** Artist / album spacing windows over the recent programmed queue. */
export interface SeparationPolicy {
  enabled: boolean;
  /** Min distance between tracks with the same artist. Default 4. */
  artistWindow: number;
  /** Min distance between tracks from the same album. Default 6. */
  albumWindow: number;
  /**
   * When no candidate satisfies the windows, still place one (best effort)
   * instead of stalling. Default true.
   */
  relaxOnEmpty: boolean;
}

/** Soft energy continuity after rating draw. */
export interface EnergyBiasPolicy {
  enabled: boolean;
  /**
   * Prefer next energy within this absolute distance of the previous track's
   * energy (0–1 scale from TagStore). Default 0.35.
   */
  maxJump: number;
}

export interface SmartRotationTrackMeta extends HarmonicTrackMeta {
  artist?: string;
  album?: string;
  /** 0–1 when known; missing → energy bias ignores the track for scoring. */
  energy?: number;
}

export interface SmartRotationOpts {
  separation?: SeparationPolicy | null;
  rating?: RatingWeightOpts | null;
  energyBias?: EnergyBiasPolicy | null;
  harmonic?: boolean;
  scoreOf?: (key: string) => number;
  rng?: () => number;
}

export const DEFAULT_SEPARATION: SeparationPolicy = {
  enabled: true,
  artistWindow: 4,
  albumWindow: 6,
  relaxOnEmpty: true,
};

export const DEFAULT_ENERGY_BIAS: EnergyBiasPolicy = {
  enabled: true,
  maxJump: 0.35,
};

export function normalizeSeparation(
  raw: Partial<SeparationPolicy> | null | undefined,
): SeparationPolicy {
  if (raw == null) return { ...DEFAULT_SEPARATION };
  return {
    enabled: raw.enabled !== false,
    artistWindow: clampInt(raw.artistWindow, 1, 32, DEFAULT_SEPARATION.artistWindow),
    albumWindow: clampInt(raw.albumWindow, 1, 48, DEFAULT_SEPARATION.albumWindow),
    relaxOnEmpty: raw.relaxOnEmpty !== false,
  };
}

export function normalizeEnergyBias(
  raw: Partial<EnergyBiasPolicy> | null | undefined,
): EnergyBiasPolicy {
  if (raw == null) return { ...DEFAULT_ENERGY_BIAS };
  let maxJump =
    typeof raw.maxJump === "number" && Number.isFinite(raw.maxJump)
      ? raw.maxJump
      : DEFAULT_ENERGY_BIAS.maxJump;
  if (maxJump < 0.05) maxJump = 0.05;
  if (maxJump > 1) maxJump = 1;
  return {
    enabled: raw.enabled !== false,
    maxJump,
  };
}

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  const v = Math.floor(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function normArtist(a?: string): string {
  return (a ?? "").trim().toLowerCase();
}

function normAlbum(a?: string): string {
  return (a ?? "").trim().toLowerCase();
}

/**
 * Reorder keys so the same artist/album does not reappear inside the lookback
 * window when alternatives exist. Greedy left-to-right placement.
 */
export function orderKeysWithSeparation(
  keys: string[],
  metaOf: (key: string) => SmartRotationTrackMeta | null | undefined,
  policy: SeparationPolicy,
): string[] {
  if (!policy.enabled || keys.length <= 1) return keys.slice();

  const remaining = keys.slice();
  const out: string[] = [];

  while (remaining.length > 0) {
    let pickIdx = -1;
    for (let i = 0; i < remaining.length; i++) {
      if (fitsWindows(remaining[i]!, out, metaOf, policy)) {
        pickIdx = i;
        break;
      }
    }
    if (pickIdx < 0) {
      if (!policy.relaxOnEmpty) {
        // Cannot place without violation and not allowed to relax — append rest
        // in original relative order (fail-open to "still play music").
        out.push(...remaining);
        break;
      }
      // Softest violation: minimize recent artist/album hits.
      pickIdx = softestViolationIndex(remaining, out, metaOf, policy);
    }
    out.push(remaining.splice(pickIdx, 1)[0]!);
  }
  return out;
}

function fitsWindows(
  key: string,
  placed: string[],
  metaOf: (key: string) => SmartRotationTrackMeta | null | undefined,
  policy: SeparationPolicy,
): boolean {
  const meta = metaOf(key);
  const artist = normArtist(meta?.artist);
  const album = normAlbum(meta?.album);
  if (!artist && !album) return true;

  const artistWin = Math.min(policy.artistWindow, placed.length);
  const albumWin = Math.min(policy.albumWindow, placed.length);

  if (artist) {
    for (let i = placed.length - artistWin; i < placed.length; i++) {
      if (i < 0) continue;
      if (normArtist(metaOf(placed[i]!)?.artist) === artist) return false;
    }
  }
  if (album) {
    for (let i = placed.length - albumWin; i < placed.length; i++) {
      if (i < 0) continue;
      if (normAlbum(metaOf(placed[i]!)?.album) === album) return false;
    }
  }
  return true;
}

function softestViolationIndex(
  remaining: string[],
  placed: string[],
  metaOf: (key: string) => SmartRotationTrackMeta | null | undefined,
  policy: SeparationPolicy,
): number {
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < remaining.length; i++) {
    const key = remaining[i]!;
    const meta = metaOf(key);
    const artist = normArtist(meta?.artist);
    const album = normAlbum(meta?.album);
    let score = 0;
    // Closer recent hits score higher (worse).
    for (let d = 1; d <= Math.max(policy.artistWindow, policy.albumWindow); d++) {
      const prev = placed[placed.length - d];
      if (!prev) break;
      const pm = metaOf(prev);
      if (artist && normArtist(pm?.artist) === artist) {
        score += policy.artistWindow - d + 1;
      }
      if (album && normAlbum(pm?.album) === album) {
        score += (policy.albumWindow - d + 1) * 0.5;
      }
    }
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Greedy energy continuity: keep order as preference bag, then walk picking the
 * candidate whose energy is closest to the previous while preferring jumps ≤ maxJump.
 * Tracks without energy keep relative order among themselves as tie-breakers.
 */
export function orderKeysByEnergyBias(
  keys: string[],
  energyOf: (key: string) => number | undefined,
  policy: EnergyBiasPolicy,
): string[] {
  if (!policy.enabled || keys.length <= 1) return keys.slice();

  const remaining = keys.slice();
  const out: string[] = [];
  // Start with the first key that has energy if any, else first key (preserve bag head).
  let startIdx = remaining.findIndex((k) => energyOf(k) != null);
  if (startIdx < 0) startIdx = 0;
  out.push(remaining.splice(startIdx, 1)[0]!);

  while (remaining.length > 0) {
    const prevE = energyOf(out[out.length - 1]!);
    let bestIdx = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const e = energyOf(remaining[i]!);
      let score = 0;
      if (prevE == null || e == null) {
        // Prefer known energy over unknown when previous is known; else preserve order.
        score = e != null ? 0.5 : 0;
      } else {
        const jump = Math.abs(e - prevE);
        score = jump <= policy.maxJump ? 2 - jump : 1 - jump;
      }
      // Slight preference for earlier bag positions (rating weight already ran).
      score += (remaining.length - i) * 0.0001;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    out.push(remaining.splice(bestIdx, 1)[0]!);
  }
  return out;
}

/**
 * Full smart-rotation pipeline on a candidate key list.
 * Caller applies auto-DJ repeat filtering before this.
 */
export function applySmartRotation(
  keys: string[],
  metaOf: (key: string) => SmartRotationTrackMeta | null | undefined,
  opts: SmartRotationOpts = {},
): string[] {
  if (keys.length <= 1) return keys.slice();

  let ordered = keys.slice();

  const separation = opts.separation
    ? normalizeSeparation(opts.separation)
    : { ...DEFAULT_SEPARATION, enabled: false };
  if (separation.enabled) {
    ordered = orderKeysWithSeparation(ordered, metaOf, separation);
  }

  // Rating weight: default ON when scoreOf is provided (matches defaultRadioConfig /
  // prior applyPoolOrdering). Explicit rating.enabled === false skips the draw.
  if (opts.scoreOf && opts.rating?.enabled !== false) {
    ordered = orderKeysByRatingWeight(
      ordered,
      opts.scoreOf,
      {
        enabled: true,
        exponent: opts.rating?.exponent ?? 1,
        maxRatio: opts.rating?.maxRatio ?? 3,
      },
      opts.rng,
    );
  }

  const energy = opts.energyBias
    ? normalizeEnergyBias(opts.energyBias)
    : { ...DEFAULT_ENERGY_BIAS, enabled: false };
  if (energy.enabled) {
    ordered = orderKeysByEnergyBias(ordered, (k) => metaOf(k)?.energy, energy);
  }

  if (opts.harmonic) {
    ordered = orderKeysHarmonically(ordered, metaOf, true);
  }

  return ordered;
}
