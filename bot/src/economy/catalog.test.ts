import { describe, expect, it } from "vitest";
import {
  CATALOG_AS_OF,
  CRAFT_RECIPES,
  catalogBrief,
  findOre,
  findRecipe,
  findRefineMethod,
  materialLabel,
  ORES,
  REFINE_METHODS,
} from "./catalog.js";

describe("catalog seed", () => {
  it("has ores and refine methods with expected core entries", () => {
    expect(ORES.length).toBeGreaterThan(10);
    expect(REFINE_METHODS.some((m) => m.id === "dinyx")).toBe(true);
    expect(findOre("quantainium")?.stability).toBe("critical");
    expect(findOre("qt")?.id).toBe("quantainium");
    expect(findOre("stileron")?.stability).toMatch(/volatile|critical|stable/);
    expect(findRefineMethod("dinyx")?.yieldRate).toBeCloseTo(0.45, 2);
    expect(findRefineMethod("cormack")?.yieldRate).toBeLessThan(0.45);
    expect(CATALOG_AS_OF.length).toBeGreaterThan(0);
  });

  it("keeps offline craft seed empty (live sc-craft only)", () => {
    expect(CRAFT_RECIPES).toHaveLength(0);
    expect(findRecipe("P4-AR")).toBeUndefined();
  });

  it("resolves material labels", () => {
    expect(materialLabel("quantainium")).toMatch(/Quantainium/i);
    expect(materialLabel("refined-quantainium")).toMatch(/Refined/i);
    expect(materialLabel("unknown-widget")).toBe("unknown-widget");
  });

  it("catalogBrief is non-empty shopping-list guidance", () => {
    const b = catalogBrief(5);
    expect(b).toMatch(/mine|refine|craft|trade/i);
    expect(b).toMatch(/Dinyx|yield/i);
  });
});
