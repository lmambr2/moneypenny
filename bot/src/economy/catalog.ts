/**
 * Seed economy catalog for org mining / refining / crafting orders.
 *
 * Policy (docs/economy.md):
 *  - Static seed committed in-repo — runtime never scrapes community UIs.
 *  - Optional live prices via the public UEX API (client, cached, attributed).
 *  - One-shot 2026-07 import snapshot: bot/src/economy/data/seed-import-2026-07.json
 *    (SC DataHub ores/refining HTML parse + UEX commodities API). Not automated.
 *
 * Resistance / instability / window / valueScuApprox are **snapshot planning
 * numbers** from that import — not a live feed. Patch and re-import manually
 * when you care.
 */

export type Stability = "stable" | "volatile" | "critical";
export type ValueTier = "low" | "mid" | "high" | "premium";
export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";
export type MineMode = "ship" | "fps";

export interface OreSpec {
  id: string;
  name: string;
  aliases: string[];
  rarity: Rarity;
  valueTier: ValueTier;
  stability: Stability;
  /**
   * Soft timer guidance for unstable ores (minutes from extraction to
   * refinery intake). null = no souring clock in this catalog.
   */
  refineWithinMin: number | null;
  /** ship laser vs FPS/ROC gem mining */
  mode: MineMode;
  /** Rock resistance (DataHub snapshot; may be negative). */
  resistance: number | null;
  /** Instability (DataHub snapshot). */
  instability: number | null;
  /** Optimal charge window (DataHub snapshot). */
  optimalWindow: number | null;
  /** Explosive charge tendency (DataHub snapshot). */
  explosive: number | null;
  /** Approximate sell value aUEC/SCU at import time (planning only). */
  valueScuApprox: number | null;
  notes: string;
  /** Preferred default refine method id from REFINE_METHODS. */
  defaultMethod: string;
  /** Hint only — locations change per patch; put org SOPs in doctrine. */
  locationsHint: string;
}

export interface RefineMethod {
  id: string;
  name: string;
  aliases: string[];
  /** Fraction of input SCU recovered as refined output (0–1), seed estimate. */
  yieldRate: number;
  /** Relative process time multiplier (1 = baseline). */
  timeMult: number;
  /** Relative aUEC cost multiplier (1 = baseline). */
  costMult: number;
  notes: string;
}

export interface CraftIngredient {
  materialId: string;
  amount: number;
  unit: "scu" | "ea";
}

export interface CraftRecipe {
  id: string;
  name: string;
  aliases: string[];
  ingredients: CraftIngredient[];
  stationHint: string;
  notes: string;
}

/** Baseline minutes + aUEC cost per SCU for a "standard" refine job (seed). */
export const REFINE_BASE = {
  minutesPerScu: 12,
  auecPerScu: 450,
} as const;

export const CATALOG_AS_OF = "2026-07-08 one-shot seed (DataHub + UEX snapshot)";

export const CATALOG_SOURCES = [
  "SC DataHub mining ores/refining (one-shot HTML parse → seed JSON; not runtime)",
  "UEX Corp public API commodities (live optional prices; snapshot flags in import JSON)",
  "SC Craft Tools blueprints (live optional; sc-craft.tools JSON API)",
  "SC Trade Tools routes (live optional; token for /api/tools/*)",
] as const;

export const CATALOG_DISCLAIMER =
  `Seed catalog (${CATALOG_AS_OF}). Rock stats/values are a frozen snapshot for ` +
  `planning — not cockpit-live. Refine yields are qualitative. Live: !econ prices ` +
  `(UEX), !craft / !econ blueprints (sc-craft), !trade (sc-trade, token). ` +
  `No HTML scrapers at runtime.`;

/**
 * Mineable materials from one-shot DataHub import (ship + FPS).
 * Spelling: Quantainium (game form); quantanium kept as alias.
 */
export const ORES: readonly OreSpec[] = [
  {
    id: "agricium",
    name: "Agricium",
    aliases: ["agri"],
    rarity: "uncommon",
    valueTier: "mid",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: 0.5,
    instability: 350.0,
    optimalWindow: 2.0,
    explosive: 4.0,
    valueScuApprox: 9657,
    notes: "Ship Mining. Res 0.5. Inst 350. Win 2. Expl 4. ~9,657 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "aluminum",
    name: "Aluminum",
    aliases: ["aluminium", "al"],
    rarity: "common",
    valueTier: "low",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: -0.4,
    instability: 0.0,
    optimalWindow: -0.5,
    explosive: -36.0,
    valueScuApprox: 3680,
    notes: "Ship Mining. Res -0.4. Inst 0. Win -0.5. Expl -36. ~3,680 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "aphorite",
    name: "Aphorite",
    aliases: [],
    rarity: "epic",
    valueTier: "premium",
    stability: "stable",
    refineWithinMin: null,
    mode: "fps",
    resistance: 0.0,
    instability: 0.0,
    optimalWindow: 0.0,
    explosive: 0.0,
    valueScuApprox: 101421,
    notes: "FPS Mining. Res 0. Inst 0. Win 0. Expl 0. ~101,421 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "ferron",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "aslarite",
    name: "Aslarite",
    aliases: ["asla"],
    rarity: "common",
    valueTier: "low",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: 0.5,
    instability: 700.0,
    optimalWindow: 0.6,
    explosive: 240.0,
    valueScuApprox: 5095,
    notes: "Ship Mining. Res 0.5. Inst 700. Win 0.6. Expl 240. ~5,095 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "beryl",
    name: "Beryl",
    aliases: [],
    rarity: "uncommon",
    valueTier: "mid",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: 0.65,
    instability: 350.0,
    optimalWindow: 1.5,
    explosive: 20.0,
    valueScuApprox: 19887,
    notes:
      "Ship Mining. Res 0.65. Inst 350. Win 1.5. Expl 20. ~19,887 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "ferron",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "bexalite",
    name: "Bexalite",
    aliases: ["bex"],
    rarity: "rare",
    valueTier: "high",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: 0.6,
    instability: 600.0,
    optimalWindow: 0.4,
    explosive: 100.0,
    valueScuApprox: 28907,
    notes:
      "Ship Mining. Res 0.6. Inst 600. Win 0.4. Expl 100. ~28,907 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "ferron",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "borase",
    name: "Borase",
    aliases: [],
    rarity: "rare",
    valueTier: "high",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: 0.3,
    instability: 40.0,
    optimalWindow: 0.5,
    explosive: 120.0,
    valueScuApprox: 27376,
    notes: "Ship Mining. Res 0.3. Inst 40. Win 0.5. Expl 120. ~27,376 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "ferron",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "carinite",
    name: "Carinite",
    aliases: [],
    rarity: "uncommon",
    valueTier: "low",
    stability: "stable",
    refineWithinMin: null,
    mode: "fps",
    resistance: 0.5,
    instability: 300.0,
    optimalWindow: 10.0,
    explosive: 0.5,
    valueScuApprox: null,
    notes: "FPS Mining. Res 0.5. Inst 300. Win 10. Expl 0.5.",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "carinite-pure",
    name: "Carinite Pure",
    aliases: [],
    rarity: "uncommon",
    valueTier: "low",
    stability: "stable",
    refineWithinMin: null,
    mode: "fps",
    resistance: 0.5,
    instability: 300.0,
    optimalWindow: 10.0,
    explosive: 0.5,
    valueScuApprox: null,
    notes: "FPS Mining. Res 0.5. Inst 300. Win 10. Expl 0.5.",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "copper",
    name: "Copper",
    aliases: ["cu"],
    rarity: "common",
    valueTier: "low",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: -0.7,
    instability: 50.0,
    optimalWindow: -0.9,
    explosive: -20.0,
    valueScuApprox: 3733,
    notes:
      "Ship Mining. Res -0.7. Inst 50. Win -0.9. Expl -20. ~3,733 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "corundum",
    name: "Corundum",
    aliases: ["coru"],
    rarity: "common",
    valueTier: "low",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: 0.1,
    instability: 50.0,
    optimalWindow: 0.5,
    explosive: -36.0,
    valueScuApprox: 3662,
    notes: "Ship Mining. Res 0.1. Inst 50. Win 0.5. Expl -36. ~3,662 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "diamond",
    name: "Diamond",
    aliases: [],
    rarity: "uncommon",
    valueTier: "mid",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: -0.07,
    instability: 0.063,
    optimalWindow: 0.25,
    explosive: 8.0,
    valueScuApprox: 7488,
    notes:
      "Ship Mining. Res -0.07. Inst 0.063. Win 0.25. Expl 8. ~7,488 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "dolivine",
    name: "Dolivine",
    aliases: [],
    rarity: "epic",
    valueTier: "premium",
    stability: "stable",
    refineWithinMin: null,
    mode: "fps",
    resistance: 0.1,
    instability: 0.0,
    optimalWindow: 0.0,
    explosive: 0.0,
    valueScuApprox: 146082,
    notes: "FPS Mining. Res 0.1. Inst 0. Win 0. Expl 0. ~146,082 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "ferron",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "flowstone",
    name: "Flowstone",
    aliases: [],
    rarity: "rare",
    valueTier: "high",
    stability: "stable",
    refineWithinMin: null,
    mode: "fps",
    resistance: -1.0,
    instability: 0.0,
    optimalWindow: 0.0,
    explosive: -1000.0,
    valueScuApprox: 98750,
    notes: "FPS Mining. Res -1. Inst 0. Win 0. Expl -1000. ~98,750 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "ferron",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "gold",
    name: "Gold",
    aliases: ["au"],
    rarity: "rare",
    valueTier: "high",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: 0.5,
    instability: 550.0,
    optimalWindow: 2.1,
    explosive: 100.0,
    valueScuApprox: 29808,
    notes:
      "Ship Mining. Res 0.5. Inst 550. Win 2.1. Expl 100. ~29,808 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "ferron",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "hadanite",
    name: "Hadanite",
    aliases: ["hada"],
    rarity: "legendary",
    valueTier: "premium",
    stability: "stable",
    refineWithinMin: null,
    mode: "fps",
    resistance: 0.0,
    instability: 200.0,
    optimalWindow: 0.0,
    explosive: 1.0,
    valueScuApprox: 545419,
    notes: "FPS Mining. Res 0. Inst 200. Win 0. Expl 1. ~545,419 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "ferron",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "hephaestanite",
    name: "Hephaestanite",
    aliases: ["heph", "hepha"],
    rarity: "common",
    valueTier: "low",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: -0.3,
    instability: 400.0,
    optimalWindow: 0.5,
    explosive: 120.0,
    valueScuApprox: 4655,
    notes:
      "Ship Mining. Res -0.3. Inst 400. Win 0.5. Expl 120. ~4,655 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "ice",
    name: "Ice",
    aliases: [],
    rarity: "common",
    valueTier: "low",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: -0.5,
    instability: 0.0,
    optimalWindow: 0.5,
    explosive: -20.0,
    valueScuApprox: null,
    notes: "Ship Mining. Res -0.5. Inst 0. Win 0.5. Expl -20.",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "iron",
    name: "Iron",
    aliases: ["fe"],
    rarity: "common",
    valueTier: "low",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: -0.4,
    instability: 50.0,
    optimalWindow: -0.9,
    explosive: 20.0,
    valueScuApprox: 3346,
    notes: "Ship Mining. Res -0.4. Inst 50. Win -0.9. Expl 20. ~3,346 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "jaclium",
    name: "Jaclium",
    aliases: [],
    rarity: "uncommon",
    valueTier: "low",
    stability: "stable",
    refineWithinMin: null,
    mode: "fps",
    resistance: 0.5,
    instability: 100.0,
    optimalWindow: 3.0,
    explosive: 1.0,
    valueScuApprox: null,
    notes: "FPS Mining. Res 0.5. Inst 100. Win 3. Expl 1.",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "janalite",
    name: "Janalite",
    aliases: ["jana"],
    rarity: "legendary",
    valueTier: "premium",
    stability: "stable",
    refineWithinMin: null,
    mode: "fps",
    resistance: 0.3,
    instability: 300.0,
    optimalWindow: 10.0,
    explosive: 1.0,
    valueScuApprox: 4326260,
    notes: "FPS Mining. Res 0.3. Inst 300. Win 10. Expl 1. ~4,326,260 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "ferron",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "laranite",
    name: "Laranite",
    aliases: ["lara"],
    rarity: "uncommon",
    valueTier: "mid",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: 0.5,
    instability: 400.0,
    optimalWindow: 0.5,
    explosive: 200.0,
    valueScuApprox: 8667,
    notes: "Ship Mining. Res 0.5. Inst 400. Win 0.5. Expl 200. ~8,667 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "lindinium",
    name: "Lindinium",
    aliases: ["lindi"],
    rarity: "epic",
    valueTier: "high",
    stability: "volatile",
    refineWithinMin: 45,
    mode: "ship",
    resistance: 0.95,
    instability: 1000.0,
    optimalWindow: 0.23,
    explosive: 260.0,
    valueScuApprox: 46925,
    notes:
      "Ship Mining. Res 0.95. Inst 1000. Win 0.23. Expl 260. ~46,925 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "ferron",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "ouratite",
    name: "Ouratite",
    aliases: ["oura"],
    rarity: "rare",
    valueTier: "high",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: 0.6,
    instability: 600.0,
    optimalWindow: 0.6,
    explosive: 240.0,
    valueScuApprox: 38205,
    notes:
      "Ship Mining. Res 0.6. Inst 600. Win 0.6. Expl 240. ~38,205 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "ferron",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "quantainium",
    name: "Quantainium",
    aliases: ["quantanium", "quanta", "q", "qt"],
    rarity: "legendary",
    valueTier: "premium",
    stability: "critical",
    refineWithinMin: 20,
    mode: "ship",
    resistance: 0.95,
    instability: 1000.0,
    optimalWindow: 2.3,
    explosive: 260.0,
    valueScuApprox: 151782,
    notes:
      "Ship Mining. Res 0.95. Inst 1000. Win 2.3. Expl 260. ~151,782 aUEC/SCU (DataHub snapshot). Sours if left raw — refine ASAP..",
    defaultMethod: "dinyx",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "quartz",
    name: "Quartz",
    aliases: [],
    rarity: "common",
    valueTier: "low",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: -0.7,
    instability: 50.0,
    optimalWindow: 0.5,
    explosive: -20.0,
    valueScuApprox: 4343,
    notes: "Ship Mining. Res -0.7. Inst 50. Win 0.5. Expl -20. ~4,343 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "riccite",
    name: "Riccite",
    aliases: ["ricc"],
    rarity: "epic",
    valueTier: "high",
    stability: "volatile",
    refineWithinMin: 60,
    mode: "ship",
    resistance: 0.95,
    instability: 850.0,
    optimalWindow: 2.3,
    explosive: 260.0,
    valueScuApprox: 68973,
    notes:
      "Ship Mining. Res 0.95. Inst 850. Win 2.3. Expl 260. ~68,973 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "ferron",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "sadaryx",
    name: "Sadaryx",
    aliases: [],
    rarity: "legendary",
    valueTier: "premium",
    stability: "stable",
    refineWithinMin: null,
    mode: "fps",
    resistance: 0.0,
    instability: 200.0,
    optimalWindow: 0.0,
    explosive: 1.0,
    valueScuApprox: 500000,
    notes: "FPS Mining. Res 0. Inst 200. Win 0. Expl 1. ~500,000 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "ferron",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "saldynium",
    name: "Saldynium",
    aliases: [],
    rarity: "uncommon",
    valueTier: "low",
    stability: "stable",
    refineWithinMin: null,
    mode: "fps",
    resistance: 0.0,
    instability: 100.0,
    optimalWindow: 5.0,
    explosive: 1.0,
    valueScuApprox: null,
    notes: "FPS Mining. Res 0. Inst 100. Win 5. Expl 1.",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "savrilium",
    name: "Savrilium",
    aliases: ["savril"],
    rarity: "legendary",
    valueTier: "premium",
    stability: "volatile",
    refineWithinMin: 45,
    mode: "ship",
    resistance: 0.95,
    instability: 1000.0,
    optimalWindow: 2.3,
    explosive: 260.0,
    valueScuApprox: 126429,
    notes:
      "Ship Mining. Res 0.95. Inst 1000. Win 2.3. Expl 260. ~126,429 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "ferron",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "silicon",
    name: "Silicon",
    aliases: ["si"],
    rarity: "common",
    valueTier: "low",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: -0.2,
    instability: 50.0,
    optimalWindow: 0.5,
    explosive: 80.0,
    valueScuApprox: 2431,
    notes: "Ship Mining. Res -0.2. Inst 50. Win 0.5. Expl 80. ~2,431 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "stileron",
    name: "Stileron",
    aliases: ["stil"],
    rarity: "legendary",
    valueTier: "premium",
    stability: "volatile",
    refineWithinMin: 60,
    mode: "ship",
    resistance: 0.6,
    instability: 870.0,
    optimalWindow: 0.6,
    explosive: 260.0,
    valueScuApprox: 136581,
    notes:
      "Ship Mining. Res 0.6. Inst 870. Win 0.6. Expl 260. ~136,581 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "ferron",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "taranite",
    name: "Taranite",
    aliases: ["tara"],
    rarity: "rare",
    valueTier: "high",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: 0.5,
    instability: 700.0,
    optimalWindow: 0.6,
    explosive: 240.0,
    valueScuApprox: 25854,
    notes:
      "Ship Mining. Res 0.5. Inst 700. Win 0.6. Expl 240. ~25,854 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "ferron",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "tin",
    name: "Tin",
    aliases: ["sn"],
    rarity: "common",
    valueTier: "low",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: -0.2,
    instability: 0.0,
    optimalWindow: 0.5,
    explosive: -36.0,
    valueScuApprox: 3954,
    notes: "Ship Mining. Res -0.2. Inst 0. Win 0.5. Expl -36. ~3,954 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "titanium",
    name: "Titanium",
    aliases: ["ti"],
    rarity: "uncommon",
    valueTier: "mid",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: 0.1,
    instability: 0.0,
    optimalWindow: -0.7,
    explosive: 20.0,
    valueScuApprox: 8023,
    notes: "Ship Mining. Res 0.1. Inst 0. Win -0.7. Expl 20. ~8,023 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "torite",
    name: "Torite",
    aliases: [],
    rarity: "uncommon",
    valueTier: "mid",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: 0.25,
    instability: 550.0,
    optimalWindow: 2.1,
    explosive: 100.0,
    valueScuApprox: 7583,
    notes:
      "Ship Mining. Res 0.25. Inst 550. Win 2.1. Expl 100. ~7,583 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "tungsten",
    name: "Tungsten",
    aliases: ["w"],
    rarity: "uncommon",
    valueTier: "mid",
    stability: "stable",
    refineWithinMin: null,
    mode: "ship",
    resistance: -0.4,
    instability: 0.0,
    optimalWindow: -0.7,
    explosive: 80.0,
    valueScuApprox: 10222,
    notes: "Ship Mining. Res -0.4. Inst 0. Win -0.7. Expl 80. ~10,222 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
  {
    id: "vlklimpet",
    name: "Vlklimpet",
    aliases: [],
    rarity: "uncommon",
    valueTier: "mid",
    stability: "stable",
    refineWithinMin: null,
    mode: "fps",
    resistance: 0.5,
    instability: 350.0,
    optimalWindow: 2.0,
    explosive: 4.0,
    valueScuApprox: 9657,
    notes: "FPS Mining. Res 0.5. Inst 350. Win 2. Expl 4. ~9,657 aUEC/SCU (DataHub snapshot).",
    defaultMethod: "cormack",
    locationsHint:
      "Patch-dependent — put org routes in doctrine; use community maps as bookmarks only",
  },
];

/**
 * Refinery methods — qualitative speed/cost/yield from DataHub method cards
 * (one-shot). Numeric rates are our planning mapping, not exported game tables.
 */
export const REFINE_METHODS: readonly RefineMethod[] = [
  {
    id: "dinyx",
    name: "Dinyx Solventation",
    aliases: ["din", "solventation"],
    yieldRate: 0.85,
    timeMult: 1.6,
    costMult: 0.7,
    notes: "DataHub: very low speed, low cost, high yield. Prefer for premium when time allows.",
  },
  {
    id: "thermonatic",
    name: "Thermonatic Deposition",
    aliases: ["thermo", "thermonatic", "deposition"],
    yieldRate: 0.7,
    timeMult: 1.25,
    costMult: 0.85,
    notes: "DataHub: low speed, low cost, moderate yield.",
  },
  {
    id: "ferron",
    name: "Ferron Exchange",
    aliases: ["fx", "exchange"],
    yieldRate: 0.78,
    timeMult: 1.15,
    costMult: 1.0,
    notes: "DataHub: low speed, moderate cost, high yield. Workhorse for valuables.",
  },
  {
    id: "electrostarolysis",
    name: "Electrostarolysis",
    aliases: ["electro", "starolysis"],
    yieldRate: 0.68,
    timeMult: 1.0,
    costMult: 1.05,
    notes: "DataHub: moderate speed/cost/yield baseline.",
  },
  {
    id: "cormack",
    name: "Cormack Method",
    aliases: ["corm"],
    yieldRate: 0.55,
    timeMult: 0.65,
    costMult: 1.0,
    notes: "DataHub: high speed, moderate cost, low yield. Bulk / clock-tight runs.",
  },
  {
    id: "pyrometric",
    name: "Pyrometric Chromalysis",
    aliases: ["pyro", "chromalysis"],
    yieldRate: 0.82,
    timeMult: 1.45,
    costMult: 1.35,
    notes: "DataHub: low speed, high cost, high yield.",
  },
];

/**
 * Offline craft seed is intentionally empty.
 * Live BOMs come from sc-craft.tools (`!craft` / `!econ blueprints`) — real
 * in-game blueprint names only. Org-specific notes go in doctrine, not here.
 */
export const CRAFT_RECIPES: readonly CraftRecipe[] = [];

function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

export function findOre(query: string): OreSpec | undefined {
  const q = norm(query);
  if (!q) return undefined;
  return ORES.find(
    (o) =>
      o.id === q ||
      norm(o.name) === q ||
      o.aliases.some((a) => norm(a) === q) ||
      o.name.toLowerCase().startsWith(q) ||
      o.id.startsWith(q),
  );
}

export function findRefineMethod(query: string): RefineMethod | undefined {
  const q = norm(query);
  if (!q) return undefined;
  return REFINE_METHODS.find(
    (m) =>
      m.id === q ||
      norm(m.name) === q ||
      m.aliases.some((a) => norm(a) === q) ||
      m.name.toLowerCase().includes(q.replace(/-/g, " ")) ||
      m.id.startsWith(q),
  );
}

export function findRecipe(query: string): CraftRecipe | undefined {
  const q = norm(query);
  if (!q) return undefined;
  return CRAFT_RECIPES.find(
    (r) =>
      r.id === q ||
      norm(r.name) === q ||
      r.aliases.some((a) => norm(a) === q) ||
      r.name.toLowerCase().includes(q.replace(/-/g, " ")) ||
      r.id.includes(q),
  );
}

export function materialLabel(materialId: string): string {
  if (materialId.startsWith("refined-")) {
    const oreId = materialId.slice("refined-".length);
    const ore = findOre(oreId);
    return ore ? `Refined ${ore.name}` : `Refined ${oreId}`;
  }
  const recipe = CRAFT_RECIPES.find((r) => r.id === materialId);
  if (recipe) return recipe.name;
  const ore = findOre(materialId);
  if (ore) return `Raw ${ore.name}`;
  return materialId;
}

/** Compact text block for RAG / !ask injection. */
export function catalogBrief(maxOres = 10): string {
  const top = [...ORES]
    .filter((o) => o.mode === "ship")
    .sort((a, b) => (b.valueScuApprox ?? 0) - (a.valueScuApprox ?? 0))
    .slice(0, maxOres)
    .map((o) => {
      const clock = o.refineWithinMin != null ? ` refine≤${o.refineWithinMin}m` : "";
      const val = o.valueScuApprox != null ? ` ~${o.valueScuApprox}aUEC` : "";
      return `${o.name}(${o.rarity},${o.stability}${clock}${val})`;
    })
    .join("; ");
  const methods = REFINE_METHODS.map(
    (m) => `${m.name}≈${Math.round(m.yieldRate * 100)}%yield`,
  ).join("; ");
  return [
    CATALOG_DISCLAIMER,
    `Sources: ${CATALOG_SOURCES.join(" · ")}`,
    `Top ship ores (snapshot): ${top}`,
    `Refine methods: ${methods}`,
    "Craft BOMs: !craft <in-game blueprint> or !econ blueprints <name> (sc-craft.tools).",
    "Trade: !trade routes ship:<name> invest:<aUEC> (sc-trade.tools; SC_TRADE_API_TOKEN).",
    "Prefer !mine / !refine / !craft / !trade / !econ for order math.",
  ].join("\n");
}
