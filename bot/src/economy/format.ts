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
import {
  formatDuration,
  formatMoney,
  shortPlace,
  type ScTradeRoute,
  type ScTradeShip,
  type ScTradeTransaction,
  SC_TRADE_ATTRIBUTION,
} from "./sc-trade.js";
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
    "Org economy (mine/refine seed · craft/trade live APIs):",
    `${prefix}mine quantainium scu:32 — mining pull + stability clock`,
    `${prefix}refine bexalite scu:32 method:dinyx — refine yield/time estimate`,
    `${prefix}craft P4-AR qty:1 — in-game blueprint BOM (sc-craft.tools)`,
    `${prefix}trade routes ship:Freelancer+MAX invest:200000 — routes (needs SC_TRADE_API_TOKEN)`,
    `${prefix}econ ores|methods — seed catalog`,
    `${prefix}econ blueprints Coda — live blueprints`,
    `${prefix}econ prices quantainium — UEX averages`,
    `${prefix}econ search stileron — seed search`,
    `${prefix}econ cache — disk cache status · ${prefix}econ refresh — re-warm catalogs`,
    "",
    CATALOG_DISCLAIMER,
  ].join("\n");
}

export function formatTradeHelp(prefix = "!"): string {
  return [
    "Trade routes via SC Trade Tools (community prices, not CIG live market):",
    `${prefix}trade routes ship:Freelancer+MAX invest:200000 stops:2 profit:time loc:Stanton`,
    `${prefix}trade buyers Agricium scu:32 loc:Stanton`,
    `${prefix}trade itinerary from:Stanton+>+microTech+>+Port+Tressler+>+Platinum+Bay to:Stanton+>+Crusader+>+Yela+>+Grim+HEX ship:Freelancer invest:100000`,
    `${prefix}trade circuit id:<from-routes> ship:Freelancer+MAX invest:200000`,
    `${prefix}trade ships Caterpillar`,
    "",
    "Ships/locations/commodities must match sc-trade.tools names. Spaces in flags: use +",
    "Requires SC_TRADE_API_TOKEN (Patreon API licence).",
    SC_TRADE_ATTRIBUTION,
  ].join("\n");
}

export function formatTradeRoutes(
  routes: ScTradeRoute[],
  meta: { ship: string; invest: number; profitType: string },
): string {
  if (routes.length === 0) {
    return [
      `No trade routes for ${meta.ship} / ${formatMoney(meta.invest)} aUEC (${meta.profitType}).`,
      "Try higher invest, different ship, or broader loc filters.",
      SC_TRADE_ATTRIBUTION,
    ].join("\n");
  }
  const lines = routes.map((r, i) => {
    const buy = r.origin;
    const sell = r.destination;
    const item = buy?.itemName || sell?.itemName || "?";
    const qty = buy?.itemQuantityInScu ?? buy?.quantityInScu ?? "?";
    const buyP = formatMoney(buy?.price);
    const sellP = formatMoney(sell?.price);
    const profit = formatMoney(r.profit);
    const ppm = r.profitPerMinute != null ? `${formatMoney(r.profitPerMinute)}/min` : "—";
    const time = formatDuration(r.timeInSeconds);
    const id = r.id != null ? ` #${r.id}` : "";
    return [
      `${i + 1}.${id} ${item} ×${qty} SCU`,
      `   Buy  ${shortPlace(buy)} @ ${buyP}`,
      `   Sell ${shortPlace(sell)} @ ${sellP}`,
      `   Profit ${profit} aUEC · ${ppm} · ${time}`,
    ].join("\n");
  });
  return [
    `📦 Trade routes — ${meta.ship} · invest ${formatMoney(meta.invest)} · sort ${meta.profitType}`,
    ...lines,
    "",
    `Loop a result: !trade circuit id:<n> ship:${meta.ship.replace(/\s+/g, "+")} invest:${meta.invest}`,
    SC_TRADE_ATTRIBUTION,
  ].join("\n");
}

export function formatTradeBuyers(
  buyers: ScTradeTransaction[],
  commodity: string,
  scu: number,
): string {
  if (buyers.length === 0) {
    return [`No buyers for ${scu} SCU ${commodity}.`, SC_TRADE_ATTRIBUTION].join("\n");
  }
  const lines = buyers.map((b, i) => {
    const price = formatMoney(b.price);
    const max = b.maxQuantityInScu != null ? ` max ${b.maxQuantityInScu} SCU` : "";
    return `  ${i + 1}. ${shortPlace(b)} — ${price} aUEC/SCU${max}`;
  });
  return [
    `💰 Best buyers — ${scu} SCU ${commodity}`,
    ...lines,
    "",
    SC_TRADE_ATTRIBUTION,
  ].join("\n");
}

export function formatTradeShips(ships: ScTradeShip[], query?: string): string {
  let list = ships;
  if (query?.trim()) {
    const q = query.trim().toLowerCase();
    list = ships.filter((s) => s.name.toLowerCase().includes(q));
  }
  const rows = list.slice(0, 40).map((s) => {
    const box = s.maxBoxSizeInScu != null ? ` box≤${s.maxBoxSizeInScu}` : "";
    return `  ${s.name}${box}`;
  });
  if (rows.length === 0) return `No ships match "${query}".`;
  return [
    query ? `Ships matching "${query}" (${list.length}):` : `Ships (${ships.length}, showing ${rows.length}):`,
    ...rows,
    "",
    "Use exact name: !trade routes ship:Freelancer+MAX invest:100000",
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
  if (CRAFT_RECIPES.length === 0) {
    return [
      "No offline seed craft recipes (by design).",
      "Use in-game blueprint names from sc-craft.tools:",
      "  !craft P4-AR qty:1",
      "  !craft Coda qty:2",
      "  !econ blueprints greatsword",
      "  !econ blueprints Coda",
      "",
      CATALOG_DISCLAIMER,
    ].join("\n");
  }
  const rows = CRAFT_RECIPES.map((r) => {
    const alias = r.aliases[0] ? ` (${r.aliases[0]})` : "";
    return `  ${r.id}${alias}`;
  });
  return [
    "Offline seed craft recipes:",
    ...rows,
    "",
    "Detail: !craft <id|alias> [qty:N] — also searches sc-craft for live blueprints.",
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
