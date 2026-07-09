import { describe, expect, it } from "vitest";
import { ScCraftClient } from "./sc-craft.js";
import { handleEconomyCommand } from "./service.js";
import { UexClient } from "./uex.js";

const sampleBp = {
  id: 3532,
  blueprint_id: "bp_craft_kbar_ballisticcannon_s2",
  name: "10-Series Greatsword Cannon",
  category: "Vehiclegear / Weapons / Ballistic / Cannon",
  craft_time_seconds: 960,
  version: "LIVE-4.8.0",
  ingredients: [
    { name: "Iron", quantity_scu: 0.64 },
    { name: "Riccite", quantity_scu: 0.09 },
    { name: "Titanium", quantity_scu: 0.32 },
  ],
};

describe("handleEconomyCommand", () => {
  it("mine / refine / craft return formatted orders", async () => {
    const mine = await handleEconomyCommand("mine", "stileron scu:16");
    expect(mine).toContain("Mine order");
    expect(mine).toContain("Stileron");

    const refine = await handleEconomyCommand("refine", "bex scu:8 method:cormack");
    expect(refine).toContain("Refine order");
    expect(refine).toContain("Cormack");

    const craftOffline = await handleEconomyCommand("craft", "P4-AR qty:1", "!", {
      scCraft: new ScCraftClient({ enabled: false }),
    });
    expect(craftOffline).toMatch(/disabled|sc-craft/i);
  });

  it("craft resolves in-game blueprint via sc-craft", async () => {
    const scCraft = new ScCraftClient({
      enabled: true,
      fetchSearch: async () => [sampleBp],
    });
    const out = await handleEconomyCommand("craft", "greatsword qty:2", "!", { scCraft });
    expect(out).toContain("Greatsword");
    expect(out).toContain("Iron");
    expect(out).toMatch(/1\.28|1.28/); // 0.64 * 2
    expect(out).toMatch(/sc-craft\.tools/i);
  });

  it("econ blueprints lists injectable hits", async () => {
    const scCraft = new ScCraftClient({
      enabled: true,
      fetchSearch: async () => [
        sampleBp,
        { id: 99, name: "Other Cannon", ingredients: [{ name: "Iron", quantity_scu: 1 }] },
      ],
    });
    const out = await handleEconomyCommand("econ", "blueprints cannon", "!", { scCraft });
    expect(out).toMatch(/Greatsword|sc-craft/i);
  });

  it("econ lists ores and methods", async () => {
    const ores = await handleEconomyCommand("econ", "ores");
    expect(ores).toContain("quantainium");
    const methods = await handleEconomyCommand("econ", "methods");
    expect(methods).toContain("dinyx");
  });

  it("econ prices uses injected UEX client", async () => {
    const uex = new UexClient({
      enabled: true,
      fetchCommodities: async () => [
        {
          id: 1,
          name: "Bexalite",
          code: "BEXA",
          is_raw: 0,
          price_sell: 28000,
          price_buy: 20000,
        },
      ],
    });
    const out = await handleEconomyCommand("econ", "prices bexalite", "!", { uex });
    expect(out).toContain("28,000");
    expect(out).toMatch(/UEX/i);
  });

  it("econ prices soft-fails when disabled", async () => {
    const uex = new UexClient({ enabled: false });
    const out = await handleEconomyCommand("econ", "prices bex", "!", { uex });
    expect(out).toMatch(/disabled/i);
  });
});
