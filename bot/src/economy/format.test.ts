import { describe, expect, it } from "vitest";
import { findOre, findRefineMethod } from "./catalog.js";
import {
  formatCraftOrder,
  formatEconHelp,
  formatMineOrder,
  formatOreList,
  formatPriceSnapshot,
  formatRefineOrder,
  formatSearch,
  formatTradeBuyers,
  formatTradeHelp,
  formatTradeRoutes,
  formatTradeShips,
} from "./format.js";
import type { CraftOrder, MineOrder, RefineOrder } from "./orders.js";
import type { UexPriceSnapshot } from "./uex.js";

describe("formatMineOrder / formatRefineOrder", () => {
  it("formats mine with unstable flag", () => {
    const ore = findOre("quantainium")!;
    const method = findRefineMethod(ore.defaultMethod)!;
    const o: MineOrder = {
      ore,
      targetScu: 32,
      stabilityLine: "⚠ refine within ~20 min or it sours",
      steps: [],
      suggestedMethod: method,
      disclaimer: "",
    };
    const s = formatMineOrder(o);
    expect(s).toMatch(/Quantainium/);
    expect(s).toMatch(/32 SCU/);
    expect(s).toMatch(/⚠️|!refine/);
  });

  it("formats refine yield line", () => {
    const ore = findOre("bexalite")!;
    const method = findRefineMethod("dinyx")!;
    const o: RefineOrder = {
      ore,
      method,
      inputScu: 32,
      outputScu: 14.4,
      estMinutes: 0,
      estAuec: 0,
      steps: [],
      disclaimer: "",
    };
    const s = formatRefineOrder(o);
    expect(s).toMatch(/14\.4/);
    expect(s).toMatch(/45%/);
  });
});

describe("formatCraftOrder / lists / help", () => {
  it("formats craft BOM without steps", () => {
    const o: CraftOrder = {
      recipe: {
        id: "p4",
        name: "P4-AR",
        aliases: [],
        ingredients: [],
        stationHint: "",
        notes: "",
      },
      qty: 2,
      bom: [
        { materialId: "ti", label: "Titanium", amount: 8, unit: "scu" },
        { materialId: "qt", label: "Quantainium", amount: 2, unit: "scu" },
      ],
      impliedRawHint: [],
      steps: ["should not show"],
      disclaimer: "",
    };
    const s = formatCraftOrder(o);
    expect(s).toMatch(/2× P4-AR/);
    expect(s).toMatch(/Titanium/);
    expect(s).toMatch(/⚠️/);
    expect(s).not.toMatch(/should not show/);
  });

  it("lists ores and points craft at live blueprints", () => {
    expect(formatOreList()).toMatch(/quantainium/i);
    expect(formatEconHelp("!")).toMatch(/workorder/);
    expect(formatTradeHelp("!")).toMatch(/SC_TRADE_API_TOKEN/);
  });

  it("search hits ore and method", () => {
    const s = formatSearch("dinyx");
    expect(s).toMatch(/method: dinyx/i);
    expect(formatSearch("zzzz-nope")).toMatch(/No catalog hits/);
  });
});

describe("format trade + prices", () => {
  it("formats routes buyers ships", () => {
    const routes = formatTradeRoutes(
      [
        {
          id: 7,
          profit: 50_000,
          profitPerMinute: 1000,
          timeInSeconds: 600,
          origin: { itemName: "Agricium", itemQuantityInScu: 16, price: 1000, shop: "A" },
          destination: { itemName: "Agricium", price: 4000, shop: "B" },
        },
      ],
      { ship: "Freelancer", invest: 100_000, profitType: "time" },
    );
    expect(routes).toMatch(/#7/);
    expect(routes).toMatch(/Agricium/);
    expect(formatTradeRoutes([], { ship: "X", invest: 1, profitType: "time" })).toMatch(/No trade/);

    const buyers = formatTradeBuyers(
      [{ price: 6400, locationAndShop: "Port Tressler", maxQuantityInScu: 100 }],
      "Agricium",
      32,
    );
    expect(buyers).toMatch(/6400|6,400/);
    expect(formatTradeBuyers([], "X", 1)).toMatch(/No buyers/);

    const ships = formatTradeShips(
      [
        { name: "Freelancer MAX", maxBoxSizeInScu: 120 },
        { name: "Caterpillar", maxBoxSizeInScu: 576 },
      ],
      "cat",
    );
    expect(ships).toMatch(/Caterpillar/);
  });

  it("formats UEX snapshot", () => {
    const snap: UexPriceSnapshot = {
      commodity: {
        id: 1,
        name: "Bexalite",
        code: "BEXA",
        price_sell: 28000,
        price_buy: 20000,
      },
      sell: 28000,
      buy: 20000,
      matches: [{ id: 1, name: "Bexalite", code: "BEXA" }],
      fetchedAt: Date.now(),
      attribution: "UEX test",
    };
    const s = formatPriceSnapshot(snap, "bex");
    expect(s).toMatch(/Bexalite/);
    expect(s).toMatch(/28,000|28000/);
    expect(s).toMatch(/UEX test/);
  });
});
