/**
 * Pure order calculators — mining / refining / crafting.
 * No I/O; safe for unit tests and command handlers.
 */
import {
  CATALOG_DISCLAIMER,
  CRAFT_RECIPES,
  type CraftRecipe,
  findOre,
  findRecipe,
  findRefineMethod,
  materialLabel,
  ORES,
  type OreSpec,
  REFINE_BASE,
  REFINE_METHODS,
  type RefineMethod,
} from "./catalog.js";

export interface MineOrder {
  ore: OreSpec;
  targetScu: number;
  stabilityLine: string;
  steps: string[];
  suggestedMethod: RefineMethod;
  disclaimer: string;
}

export interface RefineOrder {
  ore: OreSpec;
  method: RefineMethod;
  inputScu: number;
  outputScu: number;
  estMinutes: number;
  estAuec: number;
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
    return `CRITICAL — refine within ~${ore.refineWithinMin} min of extraction or risk souring.`;
  }
  if (ore.stability === "volatile" && ore.refineWithinMin != null) {
    return `VOLATILE — prefer refine within ~${ore.refineWithinMin} min; do not store raw overnight.`;
  }
  return "STABLE — no souring clock in catalog; still secure cargo.";
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

  const steps = [
    `Locate ${ore.name} — ${ore.locationsHint}.`,
    `Extract ≥ ${scu} SCU raw (account for bag/headroom).`,
    stabilityLine(ore),
    `Transit to refinery; queue ${method.name} (default for this ore).`,
    ore.notes,
  ];

  return {
    ore,
    targetScu: scu,
    stabilityLine: stabilityLine(ore),
    steps,
    suggestedMethod: method,
    disclaimer: CATALOG_DISCLAIMER,
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
  const outputScu = Math.round(input * method.yieldRate * 100) / 100;
  const estMinutes = Math.round(input * REFINE_BASE.minutesPerScu * method.timeMult);
  const estAuec = Math.round(input * REFINE_BASE.auecPerScu * method.costMult);

  const steps = [
    `Deliver ${input} SCU raw ${ore.name} to refinery intake.`,
    `Select method: ${method.name} (yield ≈ ${Math.round(method.yieldRate * 100)}% seed). ${method.notes}`,
    `Expect ~${outputScu} SCU refined · ~${estMinutes} min · ~${estAuec.toLocaleString()} aUEC (seed estimates).`,
    stabilityLine(ore),
    "Collect refined cargo; store or feed craft queue.",
  ];

  return {
    ore,
    method,
    inputScu: input,
    outputScu,
    estMinutes,
    estAuec,
    steps,
    disclaimer: CATALOG_DISCLAIMER,
  };
}

export function buildCraftOrder(recipeQuery: string, qty?: number): CraftOrder | OrderError {
  const recipe = findRecipe(recipeQuery);
  if (!recipe) {
    return {
      error:
        `No offline seed recipe for "${recipeQuery}". ` +
        `Use an in-game blueprint name via sc-craft (e.g. !craft P4-AR or !econ blueprints Coda).`,
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
      `~${rawNeeded} SCU raw ${ore.name} → ${line.amount} SCU refined via ${method.name}`,
    );
  }

  const steps = [
    `Workbench: ${recipe.stationHint}.`,
    `Craft qty ${n} × ${recipe.name}.`,
    "Stage BOM materials (see lines below).",
    recipe.notes,
    "Run craft; log surplus to org stores.",
  ];

  return {
    recipe,
    qty: n,
    bom,
    impliedRawHint,
    steps,
    disclaimer: CATALOG_DISCLAIMER,
  };
}

export function isOrderError(
  v: MineOrder | RefineOrder | CraftOrder | OrderError,
): v is OrderError {
  return "error" in v && typeof v.error === "string" && v.error.length > 0;
}
