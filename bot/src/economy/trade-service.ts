/**
 * !trade command surface — SC Trade Tools routes / buyers / itinerary / circuit.
 */
import {
  formatTradeBuyers,
  formatTradeHelp,
  formatTradeRoutes,
  formatTradeShips,
} from "./format.js";
import { getScTradeClient, type ScTradeClient } from "./sc-trade.js";
import { parseTradeArgs } from "./trade-parse.js";

const DEFAULT_SHIP = "Freelancer";
const DEFAULT_INVEST = 100_000;

export async function handleTradeCommand(
  args: string,
  prefix = "!",
  client: ScTradeClient = getScTradeClient(),
): Promise<string> {
  if (!client.isEnabled()) {
    return "Trade tools disabled (ECONOMY_SCTRADE=0).";
  }

  const f = parseTradeArgs(args);
  if (f.sub === "help" || (!args.trim() && f.sub === "routes" && !f.ship && !f.invest)) {
    // bare !trade → help
    if (!args.trim()) return formatTradeHelp(prefix);
  }
  if (f.sub === "help") return formatTradeHelp(prefix);

  if (f.sub === "ships") {
    const ships = await client.getShips();
    if (!ships) return "Could not load ship list from sc-trade (network?).";
    return formatTradeShips(ships, f.rest || f.ship);
  }

  // Token required for tool endpoints
  if (!client.hasToken()) {
    // Injected test clients without token still work via injectables.
    // hasToken false only blocks when no inject path — client methods check too.
  }

  if (f.sub === "buyers") {
    const commodity = f.commodity || f.rest;
    if (!commodity) {
      return (
        `Usage: ${prefix}trade buyers <commodity> [scu:N] [loc:Stanton]\n` +
        `Example: ${prefix}trade buyers Agricium scu:32\n` +
        `Example: ${prefix}trade buyers Quantainium scu:16 loc:Stanton`
      );
    }
    const scu = f.scu ?? 32;
    const res = await client.findBuyers({
      commodityName: commodity,
      commodityQuantityInScu: scu,
      supportedBoxSizeInScu: f.box,
      minSecurityLevel: f.security,
      locationInclude: f.loc.length ? f.loc : undefined,
    });
    if (!res.ok) return res.error;
    return formatTradeBuyers(res.buyers, commodity, scu);
  }

  if (f.sub === "itinerary") {
    const from = f.from;
    const to = f.to;
    if (!from || !to) {
      return (
        `Usage: ${prefix}trade itinerary from:<shop> to:<shop> ship:<name> invest:N\n` +
        `Shop names must match sc-trade.tools (spaces → +).\n` +
        `Example: ${prefix}trade itinerary from:Stanton+>+microTech+>+Port+Tressler+>+Platinum+Bay to:Stanton+>+Crusader+>+Yela+>+Grim+HEX ship:Freelancer invest:100000`
      );
    }
    const shipName = await resolveShipName(client, f.ship || DEFAULT_SHIP);
    if ("error" in shipName) return shipName.error;
    const invest = f.invest ?? DEFAULT_INVEST;
    const res = await client.findItinerary({
      ship: shipName.name,
      investment: invest,
      origin: from,
      destination: to,
      maxStops: f.stops ?? 3,
      profitType: f.profit ?? "time",
      supportedBoxSizeInScu: f.box ?? shipName.box,
      minSecurityLevel: f.security,
      locationInclude: f.loc.length ? f.loc : undefined,
      allowableDetour: f.detour,
    });
    if (!res.ok) return res.error;
    return formatTradeRoutes(res.routes, {
      ship: shipName.name,
      invest,
      profitType: f.profit ?? "time",
    });
  }

  if (f.sub === "circuit") {
    const id = f.tradeId ?? Number(f.rest);
    if (!Number.isFinite(id) || id <= 0) {
      return `Usage: ${prefix}trade circuit id:<tradeId> ship:<name> invest:N\n(Get id from !trade routes results.)`;
    }
    const shipName = await resolveShipName(client, f.ship || DEFAULT_SHIP);
    if ("error" in shipName) return shipName.error;
    const invest = f.invest ?? DEFAULT_INVEST;
    const res = await client.findCircuit(id, {
      ship: shipName.name,
      investment: invest,
      maxStops: f.stops ?? 2,
      profitType: f.profit ?? "time",
      supportedBoxSizeInScu: f.box ?? shipName.box,
      minSecurityLevel: f.security,
      locationInclude: f.loc.length ? f.loc : undefined,
    });
    if (!res.ok) return res.error;
    return formatTradeRoutes(res.routes, {
      ship: shipName.name,
      invest,
      profitType: f.profit ?? "time",
    });
  }

  // routes (default)
  if (f.sub === "routes" && !args.trim()) {
    return formatTradeHelp(prefix);
  }
  const shipName = await resolveShipName(client, f.ship || f.rest || DEFAULT_SHIP);
  // If rest was used as ship and no ship: flag, clear confusion when rest looks like ship
  if ("error" in shipName) {
    // try again with default if rest was commodity-like
    if (f.ship) return shipName.error;
    const fallback = await resolveShipName(client, DEFAULT_SHIP);
    if ("error" in fallback) return shipName.error;
    return runRoutes(client, fallback, f);
  }
  return runRoutes(client, shipName, f);
}

async function runRoutes(
  client: ScTradeClient,
  ship: { name: string; box?: number },
  f: ReturnType<typeof parseTradeArgs>,
) {
  const invest = f.invest ?? DEFAULT_INVEST;
  const commodityInclude = f.commodity ? [f.commodity] : f.rest && f.ship ? [f.rest] : undefined;
  const res = await client.findTrades({
    ship: ship.name,
    investment: invest,
    maxStops: f.stops ?? 1,
    profitType: f.profit ?? "time",
    supportedBoxSizeInScu: f.box ?? ship.box,
    minSecurityLevel: f.security,
    locationInclude: f.loc.length ? f.loc : undefined,
    commodityInclude,
    originShop: f.from,
  });
  if (!res.ok) return res.error;
  return formatTradeRoutes(res.routes, {
    ship: ship.name,
    invest,
    profitType: f.profit ?? "time",
  });
}

async function resolveShipName(
  client: ScTradeClient,
  query: string,
): Promise<{ name: string; box?: number } | { error: string }> {
  const hit = await client.resolveShip(query);
  if (hit) return { name: hit.name, box: hit.maxBoxSizeInScu };
  // If catalog offline, pass through user string (API may still accept).
  const ships = await client.getShips();
  if (!ships) return { name: query };
  return {
    error: `Unknown ship "${query}". Try ${"!"}trade ships ${query.split(/\s+/)[0] || ""}`.trim(),
  };
}
