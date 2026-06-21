import { describe, it, expect } from "vitest";
import { isDoctrineExpired } from "./validity.js";

describe("isDoctrineExpired", () => {
  it("treats missing valid_until as never expired", () => {
    expect(isDoctrineExpired(undefined)).toBe(false);
    expect(isDoctrineExpired("")).toBe(false);
  });

  it("is inclusive through end of valid_until day (UTC)", () => {
    const lastDay = new Date("2026-06-21T12:00:00Z");
    expect(isDoctrineExpired("2026-06-21", lastDay)).toBe(false);
    const nextDay = new Date("2026-06-22T00:00:01Z");
    expect(isDoctrineExpired("2026-06-21", nextDay)).toBe(true);
  });

  it("ignores unparseable dates (do not hide docs on bad metadata)", () => {
    expect(isDoctrineExpired("soon")).toBe(false);
  });
});