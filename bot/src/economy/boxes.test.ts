import { describe, expect, it } from "vitest";
import {
  boxFootprint,
  boxSummary,
  calculateBoxes,
  fitsShipMaxBox,
  formatBoxBreakdown,
  formatScuWithBoxes,
  largestCrateThatFits,
  volumeFitsShip,
  wholeScu,
} from "./boxes.js";

describe("calculateBoxes (E-BOX)", () => {
  it("breaks 64 into 2×32", () => {
    const b = calculateBoxes(64);
    expect(b.scu).toBe(64);
    expect(b.label).toBe("2×32");
    expect(b.totalBoxes).toBe(2);
    expect(b.crates).toEqual([{ sizeScu: 32, count: 2 }]);
  });

  it("handles edge amounts", () => {
    expect(calculateBoxes(0).label).toBe("");
    expect(calculateBoxes(1).label).toBe("1×1");
    expect(calculateBoxes(31).label).toBe("1×24 + 1×4 + 1×2 + 1×1");
    expect(calculateBoxes(33).label).toBe("1×32 + 1×1");
    expect(calculateBoxes(100).label).toBe("3×32 + 1×4");
  });

  it("ceils fractional SCU", () => {
    expect(wholeScu(32.1)).toBe(33);
    expect(calculateBoxes(32.1).scu).toBe(33);
  });

  it("format helpers", () => {
    expect(formatBoxBreakdown(calculateBoxes(40))).toBe("1×32 + 1×8");
    expect(formatScuWithBoxes(64)).toBe("64 SCU (2×32)");
    expect(formatScuWithBoxes(0)).toBe("0 SCU");
    expect(boxSummary(16).largestCrate).toBe(16);
  });
});

describe("footprints + ship fit (E-FOOT)", () => {
  it("returns footprint for standard crates", () => {
    expect(boxFootprint(32)).toEqual({ w: 4, d: 8, cells: 32 });
    expect(boxFootprint(1)?.cells).toBe(1);
    expect(boxFootprint(3)).toBeUndefined();
  });

  it("fitsShipMaxBox and largestCrateThatFits", () => {
    expect(fitsShipMaxBox(32, 32)).toBe(true);
    expect(fitsShipMaxBox(32, 16)).toBe(false);
    expect(largestCrateThatFits(32)).toBe(32);
    expect(largestCrateThatFits(20)).toBe(16);
    expect(largestCrateThatFits(0)).toBe(0);
    expect(volumeFitsShip(64, 32)).toBe(true);
    expect(volumeFitsShip(10, 0)).toBe(false);
  });
});
