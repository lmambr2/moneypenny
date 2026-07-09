/**
 * Lightweight economy context for !ask / !analyst injection.
 * Keyword-gated so we don't pollute every Q&A turn.
 * Static seed only — no network I/O on the ask path.
 */
import {
  CATALOG_DISCLAIMER,
  catalogBrief,
  findOre,
  findRecipe,
  findRefineMethod,
} from "./catalog.js";
import { formatCraftOrder, formatMineOrder, formatRefineOrder } from "./format.js";
import { buildCraftOrder, buildMineOrder, buildRefineOrder, isOrderError } from "./orders.js";

const ECON_KEYWORDS =
  /\b(mine|mining|miner|ore|ores|refine|refining|refinery|craft|crafting|scu|quantainium|quantanium|bexalite|taranite|laranite|borase|agricium|hephaestanite|stileron|riccite|aslarite|a\.?uec|economy|bom|bill of materials|raw cargo|souring|uex)\b/i;

export function isEconomyQuestion(question: string): boolean {
  return ECON_KEYWORDS.test(question);
}

/**
 * Returns 0–2 pseudo-RAG chunks for economy questions.
 * Prefer pointing the model at deterministic !mine/!refine/!craft for math.
 */
export function economyContextForQuestion(
  question: string,
): Array<{ text: string; source: string; score?: number }> {
  if (!isEconomyQuestion(question)) return [];

  const out: Array<{ text: string; source: string; score?: number }> = [
    {
      text: catalogBrief(),
      source: "economy/catalog",
      score: 0.95,
    },
  ];

  const tokens = question
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);

  for (const t of tokens) {
    const ore = findOre(t);
    if (ore) {
      if (/\brefin/i.test(question)) {
        const order = buildRefineOrder(ore.id, 32);
        if (!isOrderError(order)) {
          out.push({
            text: formatRefineOrder(order),
            source: `economy/refine:${ore.id}`,
            score: 1,
          });
          return out;
        }
      }
      const order = buildMineOrder(ore.id, 32);
      if (!isOrderError(order)) {
        out.push({
          text: formatMineOrder(order),
          source: `economy/mine:${ore.id}`,
          score: 1,
        });
        return out;
      }
    }
    const recipe = findRecipe(t);
    if (recipe) {
      const order = buildCraftOrder(recipe.id, 1);
      if (!isOrderError(order)) {
        out.push({
          text: formatCraftOrder(order),
          source: `economy/craft:${recipe.id}`,
          score: 1,
        });
        return out;
      }
    }
    const method = findRefineMethod(t);
    if (method) {
      out.push({
        text: `${method.name}: yield≈${Math.round(method.yieldRate * 100)}%, time×${method.timeMult}, cost×${method.costMult}. ${method.notes} ${CATALOG_DISCLAIMER}`,
        source: `economy/method:${method.id}`,
        score: 0.9,
      });
      return out;
    }
  }

  out.push({
    text: "For exact order math use: !mine <ore> scu:N, !refine <ore> scu:N method:name, !craft <recipe> qty:N, !econ ores|methods|recipes|prices <ore>. Live prices via UEX when enabled.",
    source: "economy/commands",
    score: 0.85,
  });
  return out;
}
