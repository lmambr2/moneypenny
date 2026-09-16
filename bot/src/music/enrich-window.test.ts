import { describe, expect, it } from "vitest";
import {
  isInLocalHourWindow,
  msUntilWindowCloses,
  msUntilWindowOpens,
  NIGHT_INDEX_WINDOW,
} from "./enrich-window.js";

function at(h: number, m = 0, s = 0): Date {
  const d = new Date(2026, 8, 12, h, m, s, 0);
  return d;
}

describe("night index window 02:00–07:00", () => {
  it("is open at 2am and 6:59, closed at 1:59 and 7:00", () => {
    expect(isInLocalHourWindow(at(2), NIGHT_INDEX_WINDOW)).toBe(true);
    expect(isInLocalHourWindow(at(6, 59), NIGHT_INDEX_WINDOW)).toBe(true);
    expect(isInLocalHourWindow(at(1, 59), NIGHT_INDEX_WINDOW)).toBe(false);
    expect(isInLocalHourWindow(at(7), NIGHT_INDEX_WINDOW)).toBe(false);
    expect(isInLocalHourWindow(at(15), NIGHT_INDEX_WINDOW)).toBe(false);
  });

  it("waits until 2am when called in the afternoon", () => {
    const now = at(15);
    const ms = msUntilWindowOpens(now, NIGHT_INDEX_WINDOW);
    const open = new Date(now.getTime() + ms);
    expect(open.getHours()).toBe(2);
    expect(open.getDate()).toBe(now.getDate() + 1);
  });

  it("returns 0 wait when already inside the window", () => {
    expect(msUntilWindowOpens(at(3), NIGHT_INDEX_WINDOW)).toBe(0);
  });

  it("closes at 7am", () => {
    const now = at(6, 30);
    const ms = msUntilWindowCloses(now, NIGHT_INDEX_WINDOW);
    expect(ms).toBe(30 * 60 * 1000);
  });
});
