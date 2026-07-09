/**
 * Economy command surface — deterministic org order builders + optional UEX prices.
 */
import { parseEconomyArgs } from "./parse.js";
import {
  buildCraftOrder,
  buildMineOrder,
  buildRefineOrder,
  isOrderError,
} from "./orders.js";
import {
  formatCraftOrder,
  formatEconHelp,
  formatMethodList,
  formatMineOrder,
  formatOreList,
  formatPriceSnapshot,
  formatRecipeList,
  formatRefineOrder,
  formatSearch,
} from "./format.js";
import { getUexClient, type UexClient } from "./uex.js";

export type EconomyCommand = "mine" | "refine" | "craft" | "econ";

export async function handleEconomyCommand(
  name: EconomyCommand,
  args: string,
  prefix = "!",
  uex: UexClient = getUexClient(),
): Promise<string> {
  switch (name) {
    case "mine":
      return handleMine(args, prefix);
    case "refine":
      return handleRefine(args, prefix);
    case "craft":
      return handleCraft(args, prefix);
    case "econ":
      return handleEcon(args, prefix, uex);
    default:
      return formatEconHelp(prefix);
  }
}

function handleMine(args: string, prefix: string): string {
  const { subject, scu, method } = parseEconomyArgs(args);
  if (!subject) {
    return `Usage: ${prefix}mine <ore> [scu:N] [method:name]\nExample: ${prefix}mine quantainium scu:32\n${formatOreList()}`;
  }
  const order = buildMineOrder(subject, scu, method);
  if (isOrderError(order)) return order.error;
  return formatMineOrder(order);
}

function handleRefine(args: string, prefix: string): string {
  const { subject, scu, method } = parseEconomyArgs(args);
  if (!subject) {
    return `Usage: ${prefix}refine <ore> [scu:N] [method:name]\nExample: ${prefix}refine quantainium scu:32 method:dinyx`;
  }
  const order = buildRefineOrder(subject, scu, method);
  if (isOrderError(order)) return order.error;
  return formatRefineOrder(order);
}

function handleCraft(args: string, prefix: string): string {
  const { subject, qty } = parseEconomyArgs(args);
  if (!subject) {
    return `Usage: ${prefix}craft <recipe> [qty:N]\nExample: ${prefix}craft quantum-core qty:2\n${formatRecipeList()}`;
  }
  const order = buildCraftOrder(subject, qty);
  if (isOrderError(order)) return order.error;
  return formatCraftOrder(order);
}

async function handleEcon(args: string, prefix: string, uex: UexClient): Promise<string> {
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
      return formatRecipeList();
    case "prices":
    case "price":
      return lookupPrices(rest, prefix, uex);
    case "search":
      return formatSearch(rest);
    case "help":
    case "?":
      return formatEconHelp(prefix);
    default:
      return formatSearch(trimmed);
  }
}

async function lookupPrices(query: string, prefix: string, uex: UexClient): Promise<string> {
  if (!query) {
    return `Usage: ${prefix}econ prices <ore>\nExample: ${prefix}econ prices bexalite`;
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
