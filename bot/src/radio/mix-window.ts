/**
 * Airing a window of a long DJ mix instead of the whole thing.
 *
 * Auto-DJ seeds are genre phrases, and YouTube answers those with one-to-three
 * hour mixes. Rejecting them outright starved the external half of the pool
 * (see radio-commands EXTERNAL_SEED_SUFFIX); airing them whole would hand the
 * station to a single upload for an hour. So we treat a long mix as a source of
 * segments: seek to a random point and play ~10 minutes, which makes a 3-hour
 * mix roughly 18 distinct segments rather than one interminable track.
 *
 * Playback is bounded by ffmpeg `-t`, so the stream simply ends at the limit and
 * the usual end-of-stream → trackEnd → advance path runs unchanged.
 */

/** Air this much of an over-long track. */
export const MIX_WINDOW_SEC = 10 * 60;

/**
 * Never start a window this close to the end — a seek landing at 2:58:30 of a
 * 3h mix would air 90 seconds and skip, which reads as a bug.
 */
export const MIX_WINDOW_TAIL_GUARD_SEC = 60;

/** Tracks at or under this play whole; only longer ones get windowed. */
export const MIX_WINDOW_MIN_DURATION_SEC = 15 * 60;

export interface MixWindow {
  /** Seconds to seek to before playing. */
  seekSeconds: number;
  /** Seconds of audio to air from that point. */
  maxSeconds: number;
}

export interface PlanMixWindowOpts {
  windowSec?: number;
  minDurationSec?: number;
  tailGuardSec?: number;
  rng?: () => number;
}

/**
 * Decide whether a track should be windowed, and where.
 *
 * Returns null when the track should play in full — short tracks, and tracks
 * whose duration is unknown (0/undefined). Unknown duration is deliberately
 * "play whole": a lot of local files report 0, and windowing those would chop
 * ordinary songs at 10 minutes for no reason.
 */
export function planMixWindow(
  durationSec: number | undefined | null,
  opts: PlanMixWindowOpts = {},
): MixWindow | null {
  const window = Math.max(1, opts.windowSec ?? MIX_WINDOW_SEC);
  const minDuration = Math.max(window, opts.minDurationSec ?? MIX_WINDOW_MIN_DURATION_SEC);
  const tailGuard = Math.max(0, opts.tailGuardSec ?? MIX_WINDOW_TAIL_GUARD_SEC);
  const rng = opts.rng ?? Math.random;

  const duration =
    typeof durationSec === "number" && Number.isFinite(durationSec) ? durationSec : 0;
  if (duration <= 0) return null;
  if (duration <= minDuration) return null;

  // Latest start that still yields a full window, keeping the tail guard clear.
  const latestStart = duration - window - tailGuard;
  if (latestStart <= 0) {
    // Long enough to window but not long enough to place one after the guard —
    // air the opening rather than a stub.
    return { seekSeconds: 0, maxSeconds: window };
  }

  const seekSeconds = Math.floor(rng() * latestStart);
  return { seekSeconds, maxSeconds: window };
}
