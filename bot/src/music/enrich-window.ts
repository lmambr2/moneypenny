/**
 * Local-time window for heavy library work (ID3 parse, key/BPM analyzer).
 * Hours are wall-clock on the host. start inclusive, end exclusive
 * (2–7 → 02:00:00 until 06:59:59.999).
 */

export interface LocalHourWindow {
  startHour: number;
  endHour: number;
}

export const NIGHT_INDEX_WINDOW: LocalHourWindow = { startHour: 2, endHour: 7 };

function hourStamp(d: Date): number {
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600 + d.getMilliseconds() / 3_600_000;
}

export function isInLocalHourWindow(
  now: Date,
  window: LocalHourWindow = NIGHT_INDEX_WINDOW,
): boolean {
  const { startHour, endHour } = window;
  if (startHour === endHour) return true;
  const h = hourStamp(now);
  if (startHour < endHour) return h >= startHour && h < endHour;
  return h >= startHour || h < endHour;
}

/** Milliseconds until the next window open. 0 if already inside. */
export function msUntilWindowOpens(
  now: Date,
  window: LocalHourWindow = NIGHT_INDEX_WINDOW,
): number {
  if (isInLocalHourWindow(now, window)) return 0;
  const open = new Date(now);
  open.setHours(window.startHour, 0, 0, 0);
  if (open.getTime() <= now.getTime()) open.setDate(open.getDate() + 1);
  return Math.max(0, open.getTime() - now.getTime());
}

/** Milliseconds until the window closes. 0 if already outside. */
export function msUntilWindowCloses(
  now: Date,
  window: LocalHourWindow = NIGHT_INDEX_WINDOW,
): number {
  if (!isInLocalHourWindow(now, window)) return 0;
  const close = new Date(now);
  close.setHours(window.endHour, 0, 0, 0);
  if (window.endHour <= window.startHour) {
    // wraps midnight — close is endHour tomorrow if we are past midnight start.
    if (now.getHours() >= window.startHour) close.setDate(close.getDate() + 1);
  } else if (close.getTime() <= now.getTime()) {
    close.setDate(close.getDate() + 1);
  }
  return Math.max(0, close.getTime() - now.getTime());
}
