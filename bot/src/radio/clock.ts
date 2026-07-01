/**
 * FormatClock — the pure rotation model (docs/radio.md §7). Given a wheel of
 * slots it hands out the next slot at each track boundary; the RadioDirector
 * decides what to do with it. No I/O, no time, no config lookups — trivially
 * unit-testable.
 *
 * "Every N songs" (§7) is just a synthesized wheel: N `song` slots followed by
 * one `bumper` slot. A custom `FormatClockSpec.wheel` overrides that.
 */
import type { FormatClockSpec, WheelSlot } from "./types.js";

export class FormatClock {
  private cursor = 0;
  private readonly wheel: WheelSlot[];

  constructor(wheel: WheelSlot[]) {
    // An empty wheel would divide-by-zero on cycle; fall back to all-songs so a
    // misconfiguration degrades to "just play music", never a crash.
    this.wheel = wheel.length > 0 ? wheel : [{ slot: "song" }];
  }

  /**
   * Build the wheel for the `everyNSongs` shortcut: N song slots, then a bumper.
   * `n <= 0` means "never inject on a count" — a single perpetual song slot.
   */
  static fromEveryN(n: number, sources?: WheelSlot["sources"]): FormatClock {
    if (n <= 0) return new FormatClock([{ slot: "song" }]);
    const wheel: WheelSlot[] = [];
    for (let i = 0; i < n; i++) wheel.push({ slot: "song" });
    wheel.push({ slot: "bumper", sources });
    return new FormatClock(wheel);
  }

  /** Resolve the effective clock for a config: a custom wheel if present,
   *  otherwise the every-N shortcut. */
  static forConfig(everyNSongs: number, spec?: FormatClockSpec, sources?: WheelSlot["sources"]): FormatClock {
    if (spec?.wheel && spec.wheel.length > 0) return new FormatClock(spec.wheel);
    return FormatClock.fromEveryN(everyNSongs, sources);
  }

  /** Advance the cursor and return the slot for this boundary. */
  nextSlot(): WheelSlot {
    const slot = this.wheel[this.cursor % this.wheel.length];
    this.cursor++;
    return slot;
  }

  /** Peek the next slot without advancing (for pre-fetch decisions). */
  peek(): WheelSlot {
    return this.wheel[this.cursor % this.wheel.length];
  }

  reset(): void {
    this.cursor = 0;
  }

  get length(): number {
    return this.wheel.length;
  }
}

/**
 * True when `now` falls inside any quiet-hours window (§7). Windows are local
 * "HH:MM" strings; a window whose `to` is <= `from` wraps past midnight
 * (e.g. 22:00→06:00). Malformed entries are ignored (fail open — quiet hours
 * must never be the reason music stops).
 */
export function isWithinQuietHours(
  now: Date,
  windows: { from: string; to: string }[],
): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  for (const w of windows) {
    const from = parseHHMM(w.from);
    const to = parseHHMM(w.to);
    if (from == null || to == null) continue;
    if (from === to) continue; // zero-width window
    const inWindow = from < to
      ? minutes >= from && minutes < to
      : minutes >= from || minutes < to; // wraps midnight
    if (inWindow) return true;
  }
  return false;
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
