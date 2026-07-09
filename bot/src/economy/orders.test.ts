import { describe, expect, it } from "vitest";
import { findOre } from "./catalog.js";
import { buildCraftOrder, buildMineOrder, buildRefineOrder, isOrderError } from "./orders.js";

describe("economy orders", () => {
  it("builds a quantainium mine order with critical clock", () => {
    const o = buildMineOrder("quantanium", 32); // alias
    expect(isOrderError(o)).toBe(false);
    if (isOrderError(o)) return;
    expect(o.ore.id).toBe("quantainium");
    expect(o.targetScu).toBe(32);
    expect(o.stabilityLine).toMatch(/CRITICAL/);
    expect(o.steps.length).toBeGreaterThan(2);
  });

  it("refines with dinyx high-yield estimate", () => {
    const o = buildRefineOrder("bexalite", 32, "dinyx");
    expect(isOrderError(o)).toBe(false);
    if (isOrderError(o)) return;
    expect(o.inputScu).toBe(32);
    expect(o.outputScu).toBeCloseTo(32 * 0.85, 5);
    expect(o.method.id).toBe("dinyx");
  });

  it("rejects unknown ore / method", () => {
    expect(isOrderError(buildMineOrder("unobtainium"))).toBe(true);
    expect(isOrderError(buildRefineOrder("bexalite", 8, "not-a-method"))).toBe(true);
  });

  it("builds craft BOM with implied raw", () => {
    const o = buildCraftOrder("quantum-core", 2);
    expect(isOrderError(o)).toBe(false);
    if (isOrderError(o)) return;
    expect(o.qty).toBe(2);
    expect(o.bom.some((b) => b.materialId === "refined-quantainium")).toBe(true);
    expect(o.impliedRawHint.length).toBeGreaterThan(0);
  });

  it("resolves quantanium alias to quantainium", () => {
    expect(findOre("quantanium")?.id).toBe("quantainium");
    expect(findOre("qt")?.id).toBe("quantainium");
  });
});
