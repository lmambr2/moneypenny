/**
 * Auto-DJ play-count cooldown: if a track was played `maxPlays` or more times
 * within the last `cooldownHours`, it is ineligible for radio auto-program
 * (seed pool / tag select / playlist refs). Manual !play is unaffected.
 */

export type AutoDjRepeatPolicy = {
  /** When false, no play-history filtering. Default true when policy present. */
  enabled?: boolean;
  /**
   * Play-count threshold inside the cooldown window. Default 1:
   * any play in the window blocks auto-DJ until the window slides.
   * Example: maxPlays=3 → first two plays still allow auto-DJ; third blocks.
   */
  maxPlays?: number;
  /** Rolling window length in hours (default 12). */
  cooldownHours?: number;
};

export type NormalizedAutoDjRepeat = {
  enabled: boolean;
  maxPlays: number;
  cooldownHours: number;
};

export const DEFAULT_AUTO_DJ_REPEAT: NormalizedAutoDjRepeat = {
  enabled: true,
  maxPlays: 1,
  cooldownHours: 12,
};

/** Normalize config; invalid/missing numbers fall back to defaults. */
export function normalizeAutoDjRepeat(
  raw: AutoDjRepeatPolicy | null | undefined,
): NormalizedAutoDjRepeat {
  if (raw == null) return { ...DEFAULT_AUTO_DJ_REPEAT };
  const enabled = raw.enabled !== false;
  let maxPlays =
    typeof raw.maxPlays === "number" && Number.isFinite(raw.maxPlays)
      ? Math.floor(raw.maxPlays)
      : DEFAULT_AUTO_DJ_REPEAT.maxPlays;
  if (maxPlays < 1) maxPlays = 1;
  if (maxPlays > 100) maxPlays = 100;
  let cooldownHours =
    typeof raw.cooldownHours === "number" && Number.isFinite(raw.cooldownHours)
      ? raw.cooldownHours
      : DEFAULT_AUTO_DJ_REPEAT.cooldownHours;
  if (cooldownHours < 0.25) cooldownHours = 0.25; // 15 minutes min
  if (cooldownHours > 24 * 30) cooldownHours = 24 * 30; // 30 days max
  return { enabled, maxPlays, cooldownHours };
}

/**
 * True when this song id should be skipped for auto-DJ given a set of saturated ids
 * (from play_history aggregation).
 */
export function isAutoDjRepeatBlocked(
  songId: string | null | undefined,
  saturatedIds: ReadonlySet<string> | null | undefined,
): boolean {
  if (!songId || !saturatedIds || saturatedIds.size === 0) return false;
  return saturatedIds.has(songId);
}

export function filterAutoDjRepeatEligible<T extends { id?: string | null }>(
  songs: T[],
  saturatedIds: ReadonlySet<string> | null | undefined,
): T[] {
  if (!saturatedIds || saturatedIds.size === 0) return songs;
  return songs.filter((s) => !isAutoDjRepeatBlocked(s.id, saturatedIds));
}
