/**
 * Pure order calculators — shopping lists, not guidebooks.
 * No I/O; safe for unit tests and command handlers.
 */
import {
  type CraftRecipe,
  findOre,
  findRecipe,
  findRefineMethod,
  materialLabel,
  ORES,
  type OreSpec,
  REFINE_METHODS,
  type RefineMethod,
} from "./catalog.js";

export interface MineOrder {
  ore: OreSpec;
  targetScu: number;
  stabilityLine: string;
  /** @deprecated empty — shopping list has no steps */
  steps: string[];
  suggestedMethod: RefineMethod;
  disclaimer: string;
}

export interface RefineOrder {
  ore: OreSpec;
  method: RefineMethod;
  inputScu: number;
  outputScu: number;
  /** @deprecated not shown — times were wrong */
  estMinutes: number;
  /** @deprecated not shown */
  estAuec: number;
  /** @deprecated empty */
  steps: string[];
  disclaimer: string;
}

export interface CraftBomLine {
  materialId: string;
  label: string;
  amount: number;
  unit: "scu" | "ea";
}

export interface CraftOrder {
  recipe: CraftRecipe;
  qty: number;
  bom: CraftBomLine[];
  impliedRawHint: string[];
  /** @deprecated empty */
  steps: string[];
  disclaimer: string;
}

export type OrderError = { error: string };

function parsePositive(n: number | undefined, fallback: number): number {
  if (n === undefined || Number.isNaN(n) || n <= 0) return fallback;
  return n;
}

function stabilityLine(ore: OreSpec): string {
  if (ore.stability === "critical" && ore.refineWithinMin != null) {
    return `⚠ refine within ~${ore.refineWithinMin} min or it sours`;
  }
  if (ore.stability === "volatile" && ore.refineWithinMin != null) {
    return `⚠ volatile — prefer refine within ~${ore.refineWithinMin} min`;
  }
  return "";
}

export function buildMineOrder(
  oreQuery: string,
  targetScu?: number,
  methodQuery?: string,
): MineOrder | OrderError {
  const ore = findOre(oreQuery);
  if (!ore) {
    const names = ORES.map((o) => o.id).join(", ");
    return { error: `Unknown ore "${oreQuery}". Known: ${names}` };
  }
  const scu = parsePositive(targetScu, 32);
  const method =
    (methodQuery ? findRefineMethod(methodQuery) : undefined) ??
    findRefineMethod(ore.defaultMethod) ??
    REFINE_METHODS[0]!;

  return {
    ore,
    targetScu: scu,
    stabilityLine: stabilityLine(ore),
    steps: [],
    suggestedMethod: method,
    disclaimer: "",
  };
}

export function buildRefineOrder(
  oreQuery: string,
  inputScu?: number,
  methodQuery?: string,
): RefineOrder | OrderError {
  const ore = findOre(oreQuery);
  if (!ore) {
    const names = ORES.map((o) => o.id).join(", ");
    return { error: `Unknown ore "${oreQuery}". Known: ${names}` };
  }
  if (methodQuery && !findRefineMethod(methodQuery)) {
    const names = REFINE_METHODS.map((m) => m.id).join(", ");
    return { error: `Unknown refine method "${methodQuery}". Known: ${names}` };
  }
  const method =
    (methodQuery ? findRefineMethod(methodQuery) : undefined) ??
    findRefineMethod(ore.defaultMethod) ??
    REFINE_METHODS[0]!;

  const input = parsePositive(inputScu, 32);
  // Yield is by method for every ore (not material-specific).
  const outputScu = Math.round(input * method.yieldRate * 100) / 100;

  return {
    ore,
    method,
    inputScu: input,
    outputScu,
    estMinutes: 0,
    estAuec: 0,
    steps: [],
    disclaimer: "",
  };
}

export function buildCraftOrder(recipeQuery: string, qty?: number): CraftOrder | OrderError {
  const recipe = findRecipe(recipeQuery);
  if (!recipe) {
    return {
      error:
        `No offline recipe for "${recipeQuery}". ` +
        `Try !craft P4-AR or !econ blueprints Coda (sc-craft).`,
    };
  }
  const n = Math.max(1, Math.floor(parsePositive(qty, 1)));
  const bom: CraftBomLine[] = recipe.ingredients.map((ing) => ({
    materialId: ing.materialId,
    label: materialLabel(ing.materialId),
    amount: Math.round(ing.amount * n * 1000) / 1000,
    unit: ing.unit,
  }));

  const impliedRawHint: string[] = [];
  for (const line of bom) {
    if (!line.materialId.startsWith("refined-")) continue;
    const oreId = line.materialId.slice("refined-".length);
    const ore = findOre(oreId);
    if (!ore) continue;
    const method = findRefineMethod(ore.defaultMethod) ?? REFINE_METHODS[0]!;
    const rawNeeded = Math.ceil((line.amount / method.yieldRate) * 100) / 100;
    impliedRawHint.push(
      `~${rawNeeded} SCU raw ${ore.name} (${method.name} ≈${Math.round(method.yieldRate * 100)}%)`,
    );
  }

  return {
    recipe,
    qty: n,
    bom,
    impliedRawHint,
    steps: [],
    disclaimer: "",
  };
}

export function isOrderError(
  v: MineOrder | RefineOrder | CraftOrder | OrderError,
): v is OrderError {
  return "error" in v && typeof v.error === "string" && v.error.length > 0;
}
