import { describe, expect, it } from "vitest";
import {
  MIX_WINDOW_MIN_DURATION_SEC,
  MIX_WINDOW_SEC,
  MIX_WINDOW_TAIL_GUARD_SEC,
  planMixWindow,
} from "./mix-window.js";

const THREE_HOURS = 3 * 60 * 60;

describe("planMixWindow", () => {
  it("plays ordinary tracks in full", () => {
    expect(planMixWindow(223)).toBeNull(); // Lido Shuffle
    expect(planMixWindow(MIX_WINDOW_MIN_DURATION_SEC)).toBeNull(); // exactly at the line
  });

  // A lot of local files report duration 0. Windowing those would chop ordinary
  // songs at ten minutes for no reason, so unknown duration means "play whole".
  it("plays tracks of unknown duration in full", () => {
    expect(planMixWindow(0)).toBeNull();
    expect(planMixWindow(undefined)).toBeNull();
    expect(planMixWindow(null)).toBeNull();
    expect(planMixWindow(Number.NaN)).toBeNull();
    expect(planMixWindow(-5)).toBeNull();
  });

  it("windows a long mix to the configured length", () => {
    const w = planMixWindow(THREE_HOURS, { rng: () => 0.5 });
    expect(w).not.toBeNull();
    expect(w?.maxSeconds).toBe(MIX_WINDOW_SEC);
  });

  it("places the window deterministically for a given rng", () => {
    const latestStart = THREE_HOURS - MIX_WINDOW_SEC - MIX_WINDOW_TAIL_GUARD_SEC;
    expect(planMixWindow(THREE_HOURS, { rng: () => 0 })?.seekSeconds).toBe(0);
    expect(planMixWindow(THREE_HOURS, { rng: () => 0.5 })?.seekSeconds).toBe(
      Math.floor(0.5 * latestStart),
    );
  });

  // A window starting at 2:58:30 of a 3h mix would air 90s then skip, which
  // reads as a bug rather than a segment.
  it("never starts so late that the window is cut short", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const w = planMixWindow(THREE_HOURS, { rng: () => r });
      expect(w).not.toBeNull();
      const end = w!.seekSeconds + w!.maxSeconds;
      expect(end).toBeLessThanOrEqual(THREE_HOURS - MIX_WINDOW_TAIL_GUARD_SEC);
    }
  });

  it("airs the opening when the track cannot fit a placed window", () => {
    // Unreachable with the defaults (minDuration 900s already exceeds
    // window+guard = 660s), so drive it with a threshold that allows it:
    // a 610s track cannot hold a 600s window plus a 60s tail guard.
    const w = planMixWindow(610, {
      windowSec: 600,
      minDurationSec: 600,
      tailGuardSec: 60,
      rng: () => 0.99,
    });
    expect(w).toEqual({ seekSeconds: 0, maxSeconds: 600 });
  });

  it("with defaults, a windowed track always has room for a placed window", () => {
    // Documents why the fallback above cannot trigger in production: the
    // threshold is deliberately further out than window + guard.
    expect(MIX_WINDOW_MIN_DURATION_SEC).toBeGreaterThan(MIX_WINDOW_SEC + MIX_WINDOW_TAIL_GUARD_SEC);
  });

  it("honours custom window and threshold options", () => {
    const w = planMixWindow(3600, {
      windowSec: 1200,
      minDurationSec: 1800,
      tailGuardSec: 0,
      rng: () => 0,
    });
    expect(w).toEqual({ seekSeconds: 0, maxSeconds: 1200 });
    // Same track, threshold above its duration → untouched.
    expect(planMixWindow(3600, { minDurationSec: 7200 })).toBeNull();
  });

  it("returns an integer seek — ffmpeg -ss takes seconds", () => {
    const w = planMixWindow(THREE_HOURS, { rng: () => 0.3333333 });
    expect(Number.isInteger(w?.seekSeconds)).toBe(true);
  });

  it("spreads segments across a long mix rather than clustering", () => {
    // A 3h mix should yield many distinct start points, not one.
    const starts = new Set<number>();
    for (let i = 0; i < 50; i++) {
      starts.add(planMixWindow(THREE_HOURS, { rng: () => i / 50 })!.seekSeconds);
    }
    expect(starts.size).toBeGreaterThan(40);
  });
});
