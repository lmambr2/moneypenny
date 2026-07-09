import { describe, expect, it } from "vitest";
import {
  formatMaterialName,
  isUnstableMaterial,
  unstableFlag,
  UNSTABLE_EMOJI,
} from "./material-flags.js";
import { formatMaterialList } from "./work-orders.js";
import { formatCraftOrder, formatMineOrder } from "./format.js";
import { buildMineOrder, isOrderError } from "./orders.js";

describe("material unstable flags (TS6 emoji)", () => {
  it("flags quantainium and other volatile catalog ores", () => {
    expect(isUnstableMaterial("Quantainium")).toBe(true);
    expect(isUnstableMaterial("quantanium")).toBe(true);
    expect(isUnstableMaterial("Stileron")).toBe(true);
    expect(isUnstableMaterial("Lindinium")).toBe(true);
    expect(isUnstableMaterial("Titanium")).toBe(false);
    expect(isUnstableMaterial("Iron")).toBe(false);
  });

  it("appends emoji in material list", () => {
    const s = formatMaterialList([
      { material: "Titanium", amount: 64, unit: "SCU" },
      { material: "Quantainium", amount: 13, unit: "SCU" },
    ]);
    expect(s).toContain("64 SCU of Titanium");
    expect(s).toContain(`13 SCU of Quantainium ${UNSTABLE_EMOJI}`);
    expect(formatMaterialName("Quantainium")).toBe(`Quantainium ${UNSTABLE_EMOJI}`);
    expect(unstableFlag("Iron")).toBe("");
  });

  it("flags mine order for critical ores", () => {
    const o = buildMineOrder("quantainium", 16);
    expect(isOrderError(o)).toBe(false);
    if (isOrderError(o)) return;
    const text = formatMineOrder(o);
    expect(text).toContain(UNSTABLE_EMOJI);
  });

  it("flags craft BOM lines", () => {
    const text = formatCraftOrder({
      recipe: {
        id: "x",
        name: "Thing",
        aliases: [],
        ingredients: [],
        stationHint: "",
        notes: "",
      },
      qty: 1,
      bom: [
        { materialId: "ti", label: "Titanium", amount: 1, unit: "scu" },
        { materialId: "q", label: "Quantainium", amount: 2, unit: "scu" },
      ],
      impliedRawHint: [],
      steps: [],
      disclaimer: "",
    });
    expect(text).toContain(UNSTABLE_EMOJI);
    expect(text).toMatch(/Quantainium/);
  });
});
