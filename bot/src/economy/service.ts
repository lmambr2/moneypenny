/**
 * Economy command surface:
 *  !mine / !refine — offline seed ores + refine methods
 *  !craft / !econ blueprints — sc-craft.tools in-game blueprints
 *  !econ prices — UEX averages
 *  !trade — sc-trade.tools routes (API token)
 */

import {
  formatCraftOrder,
  formatEconHelp,
  formatMethodList,
  formatMineOrder,
  formatOreList,
  formatPriceSnapshot,
  formatRecipeList,
  formatRefineOrder,
  formatScCraftBlueprint,
  formatScCraftSearch,
  formatSearch,
} from "./format.js";
import { buildCraftOrder, buildMineOrder, buildRefineOrder, isOrderError } from "./orders.js";
import { parseEconomyArgs } from "./parse.js";
import {
  blueprintToCraftOrder,
  getScCraftClient,
  type ScCraftClient,
} from "./sc-craft.js";
import { getUexClient, type UexClient } from "./uex.js";

export type EconomyCommand = "mine" | "refine" | "craft" | "econ" | "trade";

export interface EconomyDeps {
  uex?: UexClient;
  scCraft?: ScCraftClient;
  scTrade?: import("./sc-trade.js").ScTradeClient;
}

export async function handleEconomyCommand(
  name: EconomyCommand,
  args: string,
  prefix = "!",
  uexOrDeps: UexClient | EconomyDeps = getUexClient(),
): Promise<string> {
  // Back-compat: third arg used to be UexClient only.
  const deps: EconomyDeps =
    uexOrDeps && typeof (uexOrDeps as UexClient).lookupPrice === "function"
      ? { uex: uexOrDeps as UexClient }
      : (uexOrDeps as EconomyDeps);
  const uex = deps.uex ?? getUexClient();
  const scCraft = deps.scCraft ?? getScCraftClient();

  switch (name) {
    case "mine":
      return handleMine(args, prefix);
    case "refine":
      return handleRefine(args, prefix);
    case "craft":
      return handleCraft(args, prefix, scCraft);
    case "econ":
      return handleEcon(args, prefix, uex, scCraft);
    case "trade": {
      const { handleTradeCommand } = await import("./trade-service.js");
      const { getScTradeClient } = await import("./sc-trade.js");
      return handleTradeCommand(args, prefix, deps.scTrade ?? getScTradeClient());
    }
    default:
      return formatEconHelp(prefix);
  }
}

function handleMine(args: string, prefix: string): string {
  const { subject, scu, method } = parseEconomyArgs(args);
  if (!subject) {
    return (
      `Usage: ${prefix}mine <ore> [scu:N] [method:name]\n` +
      `Example: ${prefix}mine quantainium scu:32\n` +
      `Example: ${prefix}mine stileron scu:16 method:ferron\n` +
      `${formatOreList()}`
    );
  }
  const order = buildMineOrder(subject, scu, method);
  if (isOrderError(order)) return order.error;
  return formatMineOrder(order);
}

function handleRefine(args: string, prefix: string): string {
  const { subject, scu, method } = parseEconomyArgs(args);
  if (!subject) {
    return (
      `Usage: ${prefix}refine <ore> [scu:N] [method:name]\n` +
      `Example: ${prefix}refine quantainium scu:32 method:dinyx\n` +
      `Example: ${prefix}refine bexalite scu:32 method:cormack`
    );
  }
  const order = buildRefineOrder(subject, scu, method);
  if (isOrderError(order)) return order.error;
  return formatRefineOrder(order);
}

async function handleCraft(args: string, prefix: string, scCraft: ScCraftClient): Promise<string> {
  const { subject, qty } = parseEconomyArgs(args);
  if (!subject) {
    return (
      `Usage: ${prefix}craft <in-game blueprint> [qty:N]\n` +
      `Example: ${prefix}craft P4-AR qty:1\n` +
      `Example: ${prefix}craft Coda qty:2\n` +
      `Browse: ${prefix}econ blueprints greatsword\n` +
      `${formatRecipeList()}`
    );
  }
  // Offline seed (empty by design) then sc-craft.tools live blueprints.
  const seed = buildCraftOrder(subject, qty);
  if (!isOrderError(seed)) return formatCraftOrder(seed);

  if (!scCraft.isEnabled()) {
    return `${seed.error}\n(sc-craft disabled — ECONOMY_SCCRAFT=0)`;
  }
  const bp = await scCraft.resolveBlueprint(subject);
  if (!bp) {
    return (
      `No sc-craft blueprint match for "${subject}" (or API unreachable).\n` +
      `Try ${prefix}econ blueprints <name> with an in-game item (e.g. Coda, P4-AR, Agricium).`
    );
  }
  return formatCraftOrder(blueprintToCraftOrder(bp, qty ?? 1));
}

async function handleEcon(
  args: string,
  prefix: string,
  uex: UexClient,
  scCraft: ScCraftClient,
): Promise<string> {
  const trimmed = args.trim();
  if (!trimmed) return formatEconHelp(prefix);

  const space = trimmed.indexOf(" ");
  const sub = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const rest = space < 0 ? "" : trimmed.slice(space + 1).trim();

  switch (sub) {
    case "ores":
    case "ore":
      return formatOreList();
    case "methods":
    case "method":
      return formatMethodList();
    case "recipes":
    case "recipe":
      // Alias: no offline craft seed — point operators at live blueprints.
      return formatRecipeList();
    case "blueprints":
    case "blueprint":
    case "bp":
      return lookupBlueprints(rest, prefix, scCraft);
    case "prices":
    case "price":
      return lookupPrices(rest, prefix, uex);
    case "search":
      return formatSearch(rest);
    case "cache":
    case "status": {
      const { formatCacheStatus } = await import("./cache/refresh.js");
      return formatCacheStatus();
    }
    case "refresh": {
      const { refreshEconomyCatalogs, formatCacheStatus } = await import("./cache/refresh.js");
      const report = await refreshEconomyCatalogs();
      const lines = report.results.map(
        (r) => `  ${r.ok ? "✓" : "○"} ${r.source}/${r.key}: ${r.detail}`,
      );
      return [
        `Economy cache refresh ${report.ok ? "finished" : "finished with errors"}:`,
        ...lines,
        "",
        formatCacheStatus(),
      ].join("\n");
    }
    case "help":
    case "?":
      return formatEconHelp(prefix);
    default:
      return formatSearch(trimmed);
  }
}

async function lookupBlueprints(
  query: string,
  prefix: string,
  scCraft: ScCraftClient,
): Promise<string> {
  if (!query) {
    return (
      `Usage: ${prefix}econ blueprints <in-game name>\n` +
      `Example: ${prefix}econ blueprints P4-AR\n` +
      `Example: ${prefix}econ blueprints Coda`
    );
  }
  if (!scCraft.isEnabled()) {
    return "sc-craft blueprints disabled (ECONOMY_SCCRAFT=0).";
  }
  const res = await scCraft.search(query, 8);
  if (!res) {
    return `sc-craft unreachable for "${query}". Check network; retry later.`;
  }
  if (res.items.length === 0) {
    return `No sc-craft blueprints matching "${query}". Try an in-game name (Coda, P4-AR, Greatsword).`;
  }
  // Single strong hit → full BOM; otherwise list matches.
  if (res.items.length === 1 || res.total === 1) {
    const full = res.items[0]!.id != null ? await scCraft.getById(res.items[0]!.id) : null;
    return formatScCraftBlueprint(full ?? res.items[0]!, query);
  }
  return formatScCraftSearch(res, query, prefix);
}

async function lookupPrices(query: string, prefix: string, uex: UexClient): Promise<string> {
  if (!query) {
    return (
      `Usage: ${prefix}econ prices <commodity>\n` +
      `Example: ${prefix}econ prices quantainium\n` +
      `Example: ${prefix}econ prices bexalite`
    );
  }
  if (!uex.isEnabled()) {
    return "UEX prices are disabled (ECONOMY_UEX=0). Seed catalog still works via !mine/!refine/!craft.";
  }
  const snap = await uex.lookupPrice(query);
  if (!snap) {
    return (
      `No UEX commodity match for "${query}" (or UEX unreachable). ` +
      `Try again later, or use seed orders: !mine / !refine. Check spelling with !econ ores.`
    );
  }
  return formatPriceSnapshot(snap, query);
}
