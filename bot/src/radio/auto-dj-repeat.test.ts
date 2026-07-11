import { describe, expect, it } from "vitest";
import {
  filterAutoDjRepeatEligible,
  isAutoDjRepeatBlocked,
  normalizeAutoDjRepeat,
} from "./auto-dj-repeat.js";

describe("normalizeAutoDjRepeat", () => {
  it("defaults to 1 play / 12h when unset", () => {
    expect(normalizeAutoDjRepeat(undefined)).toEqual({
      enabled: true,
      maxPlays: 1,
      cooldownHours: 12,
    });
  });

  it("clamps invalid values", () => {
    expect(normalizeAutoDjRepeat({ maxPlays: 0, cooldownHours: 0 })).toMatchObject({
      maxPlays: 1,
      cooldownHours: 0.25,
    });
  });
});

describe("isAutoDjRepeatBlocked / filter", () => {
  it("blocks saturated ids only", () => {
    const sat = new Set(["a", "b"]);
    expect(isAutoDjRepeatBlocked("a", sat)).toBe(true);
    expect(isAutoDjRepeatBlocked("c", sat)).toBe(false);
    expect(isAutoDjRepeatBlocked("a", new Set())).toBe(false);
    expect(
      filterAutoDjRepeatEligible([{ id: "a" }, { id: "c" }, { id: "b" }], sat).map((s) => s.id),
    ).toEqual(["c"]);
  });
});
