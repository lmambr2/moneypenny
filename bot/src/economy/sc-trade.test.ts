import { describe, expect, it } from "vitest";
import { EconomyDiskCache } from "./cache/store.js";
import {
  buildBuyersBody,
  buildTradesBody,
  formatDuration,
  formatMoney,
  ScTradeClient,
  type ScTradeRoute,
} from "./sc-trade.js";
import { parseTradeArgs } from "./trade-parse.js";
import { handleTradeCommand } from "./trade-service.js";

const sampleRoutes: ScTradeRoute[] = [
  {
    id: 42,
    profit: 125000,
    profitPerMinute: 4200,
    timeInSeconds: 1800,
    origin: {
      itemName: "Agricium",
      itemQuantityInScu: 32,
      price: 2500,
      shop: "Stanton > Crusader > Port Tressler > Admin",
      action: "BUY",
    },
    destination: {
      itemName: "Agricium",
      price: 6400,
      shop: "Stanton > ArcCorp > Area18 > TDD",
      action: "SELL",
    },
  },
];

describe("buildTradesBody / buildBuyersBody", () => {
  it("sets required fields and defaults", () => {
    const b = buildTradesBody({ ship: "Freelancer", investment: 50_000 });
    expect(b.ship).toBe("Freelancer");
    expect(b.investment).toBe(50_000);
    expect(b.profitType).toBe("time");
    expect(b.locationNamesType).toBe("blacklist");
    expect(b.maxStops).toBe(1);
    expect(b.supportedBoxSizeInScu).toBe(32);
  });

  it("whitelists locations when provided", () => {
    const b = buildTradesBody({
      ship: "Caterpillar",
      investment: 1e6,
      locationNames: ["Stanton > microTech"],
      profitType: "pure",
      maxStops: 3,
    });
    expect(b.locationNamesType).toBe("whitelist");
    expect(b.profitType).toBe("pure");
    expect(b.maxStops).toBe(3);
  });

  it("builds buyers body", () => {
    const b = buildBuyersBody({ commodityName: "Agricium", commodityQuantityInScu: 16 });
    expect(b.commodityName).toBe("Agricium");
    expect(b.commodityQuantityInScu).toBe(16);
  });
});

describe("format helpers", () => {
  it("formats money and duration", () => {
    expect(formatMoney(125000)).toMatch(/125/);
    expect(formatDuration(90)).toMatch(/1m/);
  });
});

describe("parseTradeArgs", () => {
  it("parses routes flags", () => {
    const f = parseTradeArgs(
      "routes ship:Freelancer+MAX invest:200000 stops:2 profit:pure loc:Stanton",
    );
    expect(f.sub).toBe("routes");
    expect(f.ship).toBe("Freelancer MAX");
    expect(f.invest).toBe(200000);
    expect(f.stops).toBe(2);
    expect(f.profit).toBe("pure");
    expect(f.loc).toEqual(["Stanton"]);
  });

  it("parses buyers commodity from rest", () => {
    const f = parseTradeArgs("buyers Agricium scu:48");
    expect(f.sub).toBe("buyers");
    expect(f.rest).toBe("Agricium");
    expect(f.scu).toBe(48);
  });

  it("parses circuit id", () => {
    const f = parseTradeArgs("circuit id:42 ship:Freelancer invest:1e5");
    expect(f.sub).toBe("circuit");
    expect(f.tradeId).toBe(42);
  });
});

describe("ScTradeClient + handleTradeCommand", () => {
  it("findTrades uses injectable and caches", async () => {
    let calls = 0;
    const disk = new EconomyDiskCache(":memory:");
    const client = new ScTradeClient({
      enabled: true,
      apiToken: "test-token",
      ttlMs: 60_000,
      disk,
      postTrades: async () => {
        calls += 1;
        return sampleRoutes;
      },
      fetchShips: async () => [{ name: "Freelancer", maxBoxSizeInScu: 32 }],
    });
    const a = await client.findTrades({ ship: "Freelancer", investment: 100000 });
    const b = await client.findTrades({ ship: "Freelancer", investment: 100000 });
    expect(a.ok && a.routes[0]?.id).toBe(42);
    expect(b.ok).toBe(true);
    expect(calls).toBe(1);
    disk.close();
  });

  it("fails soft without token", async () => {
    const client = new ScTradeClient({ enabled: true, apiToken: "" });
    const res = await client.findTrades({ ship: "Freelancer", investment: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/token/i);
  });

  it("!trade routes formats injectable results", async () => {
    const client = new ScTradeClient({
      enabled: true,
      apiToken: "t",
      postTrades: async () => sampleRoutes,
      fetchShips: async () => [
        { name: "Freelancer", maxBoxSizeInScu: 32 },
        { name: "Freelancer MAX", maxBoxSizeInScu: 32 },
      ],
    });
    const out = await handleTradeCommand("routes ship:Freelancer invest:100000", "!", client);
    expect(out).toMatch(/Agricium/);
    expect(out).toMatch(/#42/);
    expect(out).toMatch(/sc-trade\.tools/i);
  });

  it("!trade buyers formats list", async () => {
    const client = new ScTradeClient({
      enabled: true,
      apiToken: "t",
      postBuyers: async () => [{ shop: "Area18 TDD", price: 6400, maxQuantityInScu: 100 }],
    });
    const out = await handleTradeCommand("buyers Agricium scu:32", "!", client);
    expect(out).toMatch(/Best buyers/);
    expect(out).toMatch(/6,400|6400/);
  });

  it("!trade ships lists catalog", async () => {
    const client = new ScTradeClient({
      enabled: true,
      fetchShips: async () => [
        { name: "Freelancer MAX", maxBoxSizeInScu: 32 },
        { name: "100i", maxBoxSizeInScu: 1 },
      ],
    });
    const out = await handleTradeCommand("ships MAX", "!", client);
    expect(out).toMatch(/Freelancer MAX/);
    expect(out).not.toMatch(/100i/);
  });
});
