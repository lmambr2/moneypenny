/**
 * TeamSpeak-friendly formatting for economy orders (compact, no markdown tables).
 */

import {
  CATALOG_DISCLAIMER,
  CRAFT_RECIPES,
  findOre,
  findRecipe,
  findRefineMethod,
  ORES,
  REFINE_METHODS,
} from "./catalog.js";
import type { CraftOrder, MineOrder, RefineOrder } from "./orders.js";
import {
  blueprintToCraftOrder,
  type ScCraftBlueprint,
  type ScCraftSearchResult,
  SC_CRAFT_ATTRIBUTION,
} from "./sc-craft.js";
import type { UexPriceSnapshot } from "./uex.js";

export function formatMineOrder(o: MineOrder): string {
  const stats: string[] = [];
  if (o.ore.resistance != null) stats.push(`Res ${o.ore.resistance}`);
  if (o.ore.instability != null) stats.push(`Inst ${o.ore.instability}`);
  if (o.ore.optimalWindow != null) stats.push(`Win ${o.ore.optimalWindow}`);
  if (o.ore.explosive != null) stats.push(`Expl ${o.ore.explosive}`);
  const val =
    o.ore.valueScuApprox != null
      ? `~${o.ore.valueScuApprox.toLocaleString()} aUEC/SCU snapshot`
      : "value n/a";
  return [
    `⛏ Mine order — ${o.ore.name} (${o.ore.rarity}, ${o.ore.mode})`,
    `Target: ${o.targetScu} SCU raw · tier ${o.ore.valueTier} · ${o.ore.stability}`,
    stats.length ? `Rock: ${stats.join(" · ")} · ${val}` : val,
    o.stabilityLine,
    `Default refine: ${o.suggestedMethod.name}`,
    "",
    "Steps:",
    ...o.steps.map((s, i) => `  ${i + 1}. ${s}`),
    "",
    o.disclaimer,
    `Next: !refine ${o.ore.id} scu:${o.targetScu}`,
  ].join("\n");
}

export function formatRefineOrder(o: RefineOrder): string {
  return [
    `⚗ Refine order — ${o.ore.name}`,
    `In: ${o.inputScu} SCU raw → Out: ~${o.outputScu} SCU refined`,
    `Method: ${o.method.name} (≈${Math.round(o.method.yieldRate * 100)}% seed yield)`,
    `Est: ~${o.estMinutes} min · ~${o.estAuec.toLocaleString()} aUEC`,
    "",
    "Steps:",
    ...o.steps.map((s, i) => `  ${i + 1}. ${s}`),
    "",
    o.disclaimer,
  ].join("\n");
}

export function formatCraftOrder(o: CraftOrder): string {
  const bom = o.bom.map((b) => `  • ${b.amount} ${b.unit} ${b.label}`);
  const raw =
    o.impliedRawHint.length > 0
      ? ["", "Implied raw (via default refine yields):", ...o.impliedRawHint.map((h) => `  • ${h}`)]
      : [];
  return [
    `🔧 Craft order — ${o.qty}× ${o.recipe.name}`,
    `Station: ${o.recipe.stationHint}`,
    "",
    "Bill of materials:",
    ...bom,
    ...raw,
    "",
    "Steps:",
    ...o.steps.map((s, i) => `  ${i + 1}. ${s}`),
    "",
    o.disclaimer,
  ].join("\n");
}

export function formatEconHelp(prefix = "!"): string {
  return [
    "Org economy orders (seed + optional UEX prices + sc-craft blueprints):",
    `${prefix}mine <ore> [scu:N] [method:name] — mining pull order + stability clock`,
    `${prefix}refine <ore> [scu:N] [method:name] — refine yield / time / cost estimate`,
    `${prefix}craft <recipe|blueprint> [qty:N] — seed BOM or live sc-craft blueprint`,
    `${prefix}econ ores|methods|recipes — seed catalog`,
    `${prefix}econ blueprints <q> — live blueprints (sc-craft.tools)`,
    `${prefix}econ prices <ore> — UEX averages`,
    `${prefix}econ search <q> — seed search`,
    "",
    CATALOG_DISCLAIMER,
    "Live blueprints: public sc-craft.tools JSON API (cached). No HTML scrapers.",
  ].join("\n");
}

export function formatScCraftBlueprint(bp: ScCraftBlueprint, query: string): string {
  const order = blueprintToCraftOrder(bp, 1);
  const head = [
    `🔧 sc-craft blueprint — ${bp.name}`,
    query ? `Query: ${query}` : "",
    bp.category ? `Category: ${bp.category}` : "",
    bp.version ? `Game data: ${bp.version}` : "",
    bp.blueprint_id ? `Id: ${bp.blueprint_id}` : "",
  ].filter(Boolean);
  const body = formatCraftOrder(order);
  // Drop duplicate title line from formatCraftOrder
  const rest = body.split("\n").slice(1).join("\n");
  return [...head, "", rest].join("\n");
}

export function formatScCraftSearch(
  res: ScCraftSearchResult,
  query: string,
  prefix = "!",
): string {
  const lines = res.items.slice(0, 8).map((bp, i) => {
    const ings = bp.ingredients?.length ?? 0;
    const cat = bp.category ? ` · ${bp.category.split(" / ").slice(-2).join(" / ")}` : "";
    return `  ${i + 1}. ${bp.name}${cat}${ings ? ` (${ings} mats)` : ""}`;
  });
  return [
    `sc-craft blueprints matching "${query}" (${res.total} total):`,
    ...lines,
    "",
    `Detail: ${prefix}craft <name>  or  ${prefix}econ blueprints <more-specific-name>`,
    res.attribution,
  ].join("\n");
}

export function formatScCraftAttribution(): string {
  return SC_CRAFT_ATTRIBUTION;
}

export function formatOreList(): string {
  const rows = ORES.map((o) => {
    const clock = o.refineWithinMin != null ? ` ≤${o.refineWithinMin}m` : "";
    const val = o.valueScuApprox != null ? ` ~${Math.round(o.valueScuApprox / 1000)}k` : "";
    return `  ${o.id.padEnd(16)} ${o.mode.padEnd(5)} ${o.rarity.padEnd(10)} ${o.stability.padEnd(9)}${clock}${val}`;
  });
  return [
    "Ores (id · mode · rarity · stability · ~k aUEC snapshot):",
    ...rows,
    "",
    CATALOG_DISCLAIMER,
  ].join("\n");
}

export function formatMethodList(): string {
  const rows = REFINE_METHODS.map(
    (m) =>
      `  ${m.id.padEnd(16)} yield≈${Math.round(m.yieldRate * 100)}%  time×${m.timeMult}  cost×${m.costMult}`,
  );
  return ["Refine methods (seed estimates):", ...rows, "", CATALOG_DISCLAIMER].join("\n");
}

export function formatRecipeList(): string {
  const rows = CRAFT_RECIPES.map((r) => {
    const alias = r.aliases[0] ? ` (${r.aliases[0]})` : "";
    return `  ${r.id}${alias}`;
  });
  return [
    "Craft recipes (illustrative — put live BOMs in doctrine):",
    ...rows,
    "",
    "Detail: !craft <id|alias> [qty:N]",
    "",
    CATALOG_DISCLAIMER,
  ].join("\n");
}

export function formatSearch(query: string): string {
  const q = query.trim().toLowerCase();
  if (!q) return "Usage: !econ search <ore|method|recipe>";
  const hits: string[] = [];
  for (const o of ORES) {
    if (
      o.id.includes(q) ||
      o.name.toLowerCase().includes(q) ||
      o.aliases.some((a) => a.toLowerCase().includes(q))
    ) {
      hits.push(`ore: ${o.id} — ${o.name} (${o.rarity}, ${o.stability})`);
    }
  }
  for (const m of REFINE_METHODS) {
    if (
      m.id.includes(q) ||
      m.name.toLowerCase().includes(q) ||
      m.aliases.some((a) => a.toLowerCase().includes(q))
    ) {
      hits.push(`method: ${m.id} — ${m.name} (≈${Math.round(m.yieldRate * 100)}%)`);
    }
  }
  for (const r of CRAFT_RECIPES) {
    if (
      r.id.includes(q) ||
      r.name.toLowerCase().includes(q) ||
      r.aliases.some((a) => a.toLowerCase().includes(q))
    ) {
      hits.push(`recipe: ${r.id} — ${r.name}`);
    }
  }
  const ore = findOre(q);
  const method = findRefineMethod(q);
  const recipe = findRecipe(q);
  if (ore && !hits.some((h) => h.startsWith(`ore: ${ore.id}`))) {
    hits.unshift(`ore: ${ore.id} — ${ore.name} (${ore.rarity}, ${ore.stability})`);
  }
  if (method && !hits.some((h) => h.startsWith(`method: ${method.id}`))) {
    hits.unshift(`method: ${method.id} — ${method.name}`);
  }
  if (recipe && !hits.some((h) => h.startsWith(`recipe: ${recipe.id}`))) {
    hits.unshift(`recipe: ${recipe.id} — ${recipe.name}`);
  }
  if (hits.length === 0) return `No catalog hits for "${query}". Try !econ ores|methods|recipes.`;
  return [`Catalog search "${query}":`, ...hits.map((h) => `  ${h}`)].join("\n");
}

export function formatPriceSnapshot(snap: UexPriceSnapshot, query: string): string {
  const ageMin = Math.max(0, Math.round((Date.now() - snap.fetchedAt) / 60_000));
  const sell = snap.sell != null ? `${snap.sell.toLocaleString()} aUEC/SCU sell` : "no sell price";
  const buy = snap.buy != null ? `${snap.buy.toLocaleString()} aUEC/SCU buy` : "no buy price";
  const flags: string[] = [];
  if (snap.commodity.is_volatile_time) flags.push("time-volatile");
  if (snap.commodity.is_volatile_qt) flags.push("qt-volatile");
  if (snap.commodity.is_raw) flags.push("raw-row");
  const flagLine = flags.length ? `Flags: ${flags.join(", ")}` : "";
  const alts =
    snap.matches.length > 1
      ? `Matches: ${snap.matches
          .map((m) => m.name)
          .slice(0, 6)
          .join("; ")}`
      : "";
  return [
    `💰 UEX price — ${snap.commodity.name} (query: ${query})`,
    `${sell} · ${buy}`,
    flagLine,
    alts,
    `Cache age: ~${ageMin} min`,
    "",
    snap.attribution,
    "Terminal-level routes: use UEX in a browser — we only surface commodity averages.",
  ]
    .filter(Boolean)
    .join("\n");
}
