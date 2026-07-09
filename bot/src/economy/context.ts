/**
 * Lightweight economy context for !ask / !analyst injection.
 * Keyword-gated so we don't pollute every Q&A turn.
 *
 * Ask path is **sync + offline**: seed catalog + disk-cache wiki enrichment.
 * No network I/O here (network refresh is scheduled separately).
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
import { getScWikiClient } from "./sc-wiki.js";

const ECON_KEYWORDS =
  /\b(mine|mining|miner|ore|ores|refine|refining|refinery|craft|crafting|trade|trading|route|routes|hauling|haul|scu|quantainium|quantanium|bexalite|taranite|laranite|borase|agricium|hephaestanite|stileron|riccite|aslarite|a\.?uec|economy|bom|bill of materials|raw cargo|souring|uex|blueprint|ship|cargo)\b/i;

export function isEconomyQuestion(question: string): boolean {
  return ECON_KEYWORDS.test(question);
}

/**
 * Returns 0–3 pseudo-RAG chunks for economy questions.
 * Prefer pointing the model at deterministic !mine/!refine/!craft/!trade for math.
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

  // Wiki enrichment from **disk cache only** (warmed by scheduler / !econ refresh).
  try {
    const wiki = getScWikiClient();
    for (const t of tokens) {
      if (t.length < 4) continue;
      const snippet = wiki.readCachedEnrichment(t);
      if (snippet) {
        out.push({
          text: snippet,
          source: `economy/wiki-cache:${t}`,
          score: 0.92,
        });
        break;
      }
    }
    // Also try multi-word commodity names from question
    const oreish = question.match(
      /\b(quantainium|quantanium|bexalite|agricium|stileron|hephaestanite|laranite|taranite|titanium|tungsten)\b/i,
    );
    if (oreish && !out.some((c) => c.source.startsWith("economy/wiki-cache:"))) {
      const snippet = wiki.readCachedEnrichment(oreish[1]!);
      if (snippet) {
        out.push({ text: snippet, source: `economy/wiki-cache:${oreish[1]}`, score: 0.93 });
      }
    }
  } catch {
    /* ignore */
  }

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
    text:
      "For exact order math use: !mine <ore> scu:N, !refine <ore> scu:N method:name, " +
      "!craft <blueprint> qty:N, !trade routes ship:… invest:N, " +
      "!econ prices <commodity>, !econ blueprints <name>, !econ cache.",
    source: "economy/commands",
    score: 0.85,
  });
  return out;
}
