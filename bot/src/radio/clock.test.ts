import { describe, it, expect } from "vitest";
import { FormatClock, isWithinQuietHours } from "./clock.js";

describe("FormatClock", () => {
  it("fromEveryN synthesizes N song slots then a bumper", () => {
    const c = FormatClock.fromEveryN(3);
    expect(c.length).toBe(4);
    const kinds = [c.nextSlot(), c.nextSlot(), c.nextSlot(), c.nextSlot()].map((s) => s.slot);
    expect(kinds).toEqual(["song", "song", "song", "bumper"]);
  });

  it("cycles the wheel", () => {
    const c = FormatClock.fromEveryN(1); // [song, bumper]
    const seq = Array.from({ length: 5 }, () => c.nextSlot().slot);
    expect(seq).toEqual(["song", "bumper", "song", "bumper", "song"]);
  });

  it("n<=0 means never inject on a count (all songs)", () => {
    const c = FormatClock.fromEveryN(0);
    expect([c.nextSlot(), c.nextSlot()].map((s) => s.slot)).toEqual(["song", "song"]);
  });

  it("forConfig prefers a custom wheel over every-N", () => {
    const c = FormatClock.forConfig(4, { wheel: [{ slot: "stationId" }, { slot: "song" }] });
    expect([c.nextSlot().slot, c.nextSlot().slot, c.nextSlot().slot]).toEqual([
      "stationId",
      "song",
      "stationId",
    ]);
  });

  it("empty wheel degrades to all-songs (never crashes)", () => {
    const c = new FormatClock([]);
    expect(c.nextSlot().slot).toBe("song");
  });

  it("peek does not advance", () => {
    const c = FormatClock.fromEveryN(2);
    expect(c.peek().slot).toBe("song");
    expect(c.peek().slot).toBe("song");
    expect(c.nextSlot().slot).toBe("song");
  });
});

describe("isWithinQuietHours", () => {
  const at = (h: number, m = 0) => new Date(2026, 5, 30, h, m);

  it("matches an in-day window", () => {
    const w = [{ from: "02:00", to: "08:00" }];
    expect(isWithinQuietHours(at(3), w)).toBe(true);
    expect(isWithinQuietHours(at(8), w)).toBe(false); // end is exclusive
    expect(isWithinQuietHours(at(1), w)).toBe(false);
  });

  it("handles a window that wraps midnight", () => {
    const w = [{ from: "22:00", to: "06:00" }];
    expect(isWithinQuietHours(at(23), w)).toBe(true);
    expect(isWithinQuietHours(at(2), w)).toBe(true);
    expect(isWithinQuietHours(at(12), w)).toBe(false);
  });

  it("ignores malformed / zero-width windows (fail open)", () => {
    expect(isWithinQuietHours(at(3), [{ from: "nope", to: "08:00" }])).toBe(false);
    expect(isWithinQuietHours(at(3), [{ from: "03:00", to: "03:00" }])).toBe(false);
    expect(isWithinQuietHours(at(3), [])).toBe(false);
  });
});
