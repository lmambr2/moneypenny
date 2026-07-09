import { describe, expect, it } from "vitest";
import {
  blueprintToBom,
  blueprintToCraftOrder,
  scoreBlueprintMatch,
  ScCraftClient,
  type ScCraftBlueprint,
} from "./sc-craft.js";

const SAMPLE: ScCraftBlueprint = {
  id: 3532,
  blueprint_id: "bp_craft_kbar_ballisticcannon_s2",
  name: "10-Series Greatsword Cannon",
  category: "Vehiclegear / Weapons / Ballistic / Cannon",
  craft_time_seconds: 960,
  version: "LIVE-4.8.0-12030094",
  ingredients: [
    {
      slot: "FRAME",
      name: "Iron",
      quantity_scu: 0.64,
      options: [{ name: "Iron", quantity_scu: 0.64, unit: "scu" }],
    },
    {
      slot: "CYCLER",
      name: "Riccite",
      quantity_scu: 0.09,
    },
    {
      slot: "BARREL",
      name: "Titanium",
      quantity_scu: 0.32,
    },
  ],
};

describe("scoreBlueprintMatch", () => {
  it("ranks exact and partial names", () => {
    expect(scoreBlueprintMatch("10-Series Greatsword Cannon", SAMPLE)).toBe(100);
    expect(scoreBlueprintMatch("greatsword", SAMPLE)).toBeGreaterThan(50);
    expect(scoreBlueprintMatch("zzzz-nope", SAMPLE)).toBe(0);
  });
});

describe("blueprintToBom / blueprintToCraftOrder", () => {
  it("scales SCU BOM by qty", () => {
    const bom = blueprintToBom(SAMPLE, 2);
    expect(bom).toHaveLength(3);
    expect(bom[0]).toMatchObject({ label: "Iron", amount: 1.28, unit: "scu" });
    expect(bom[1]?.amount).toBe(0.18);
  });

  it("builds craft order with attribution", () => {
    const order = blueprintToCraftOrder(SAMPLE, 1);
    expect(order.recipe.name).toContain("Greatsword");
    expect(order.bom.some((b) => b.label === "Iron")).toBe(true);
    expect(order.disclaimer).toMatch(/sc-craft\.tools/i);
    expect(order.steps.some((s) => /craft time/i.test(s))).toBe(true);
  });
});

describe("ScCraftClient", () => {
  it("resolveBlueprint picks best injectable match", async () => {
    const client = new ScCraftClient({
      enabled: true,
      fetchSearch: async () => [
        { id: 1, name: "Other Gun", ingredients: [] },
        SAMPLE,
      ],
    });
    const bp = await client.resolveBlueprint("greatsword cannon");
    expect(bp?.name).toMatch(/Greatsword/);
  });

  it("fails soft when disabled", async () => {
    const client = new ScCraftClient({
      enabled: false,
      fetchSearch: async () => {
        throw new Error("should not run");
      },
    });
    expect(await client.search("iron")).toBeNull();
    expect(await client.resolveBlueprint("iron")).toBeNull();
  });

  it("fails soft when fetch throws", async () => {
    const client = new ScCraftClient({
      enabled: true,
      fetchSearch: async () => {
        throw new Error("offline");
      },
    });
    expect(await client.search("greatsword")).toBeNull();
  });

  it("caches search results within TTL", async () => {
    let calls = 0;
    const client = new ScCraftClient({
      enabled: true,
      ttlMs: 60_000,
      fetchSearch: async () => {
        calls += 1;
        return [SAMPLE];
      },
    });
    await client.search("greatsword");
    await client.search("greatsword");
    expect(calls).toBe(1);
  });
});
