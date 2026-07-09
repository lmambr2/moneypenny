/**
 * Economy command surface — seed orders + optional UEX prices + sc-craft blueprints.
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

export type EconomyCommand = "mine" | "refine" | "craft" | "econ";

export interface EconomyDeps {
  uex?: UexClient;
  scCraft?: ScCraftClient;
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

async function handleCraft(args: string, prefix: string, scCraft: ScCraftClient): Promise<string> {
  const { subject, qty } = parseEconomyArgs(args);
  if (!subject) {
    return (
      `Usage: ${prefix}craft <recipe|blueprint> [qty:N]\n` +
      `Example: ${prefix}craft quantum-core qty:2 · ${prefix}craft greatsword\n` +
      `${formatRecipeList()}\n` +
      `Live blueprints: ${prefix}econ blueprints <query> (sc-craft.tools when enabled).`
    );
  }
  // 1) Seed catalog (offline, always available).
  const seed = buildCraftOrder(subject, qty);
  if (!isOrderError(seed)) return formatCraftOrder(seed);

  // 2) Optional live blueprints from SC Craft Tools.
  if (!scCraft.isEnabled()) {
    return `${seed.error}\n(sc-craft live blueprints disabled — ECONOMY_SCCRAFT=0)`;
  }
  const bp = await scCraft.resolveBlueprint(subject);
  if (!bp) {
    return (
      `${seed.error}\n` +
      `No sc-craft blueprint match for "${subject}" (or API unreachable). ` +
      `Try ${prefix}econ blueprints <query> or ${prefix}econ recipes.`
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
    return `Usage: ${prefix}econ blueprints <name>\nExample: ${prefix}econ blueprints greatsword`;
  }
  if (!scCraft.isEnabled()) {
    return "sc-craft blueprints disabled (ECONOMY_SCCRAFT=0). Seed recipes: !econ recipes.";
  }
  const res = await scCraft.search(query, 8);
  if (!res) {
    return (
      `sc-craft unreachable or empty for "${query}". ` +
      `Seed recipes still work: !econ recipes / !craft <seed-id>.`
    );
  }
  if (res.items.length === 0) {
    return `No sc-craft blueprints matching "${query}". Try a shorter name (e.g. sniper, iron).`;
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
