/**
 * E-BOX / E-FOOT — standard cargo crate math (community haul-tool idea, pure TS).
 *
 * Standard SC box sizes: 1, 2, 4, 8, 16, 24, 32 SCU (matches UEX container_sizes).
 * No 3D packing — greedy fewest-crates breakdown only.
 */

/** Largest → smallest standard freight boxes. */
export const STANDARD_CRATE_SCU = [32, 24, 16, 8, 4, 2, 1] as const;

export type StandardCrateScu = (typeof STANDARD_CRATE_SCU)[number];

/** Grid footprint (width × depth cells) for each crate size — planning heuristic. */
export const CRATE_FOOTPRINTS: Readonly<
  Record<StandardCrateScu, { w: number; d: number; cells: number }>
> = {
  1: { w: 1, d: 1, cells: 1 },
  2: { w: 1, d: 2, cells: 2 },
  4: { w: 2, d: 2, cells: 4 },
  8: { w: 2, d: 4, cells: 8 },
  16: { w: 2, d: 8, cells: 16 },
  24: { w: 3, d: 8, cells: 24 },
  32: { w: 4, d: 8, cells: 32 },
};

export interface BoxCount {
  sizeScu: StandardCrateScu;
  count: number;
}

export interface BoxBreakdown {
  /** Whole SCU packed (ceil of input when fractional). */
  scu: number;
  /** Crates largest-first. */
  crates: BoxCount[];
  /** Total number of boxes. */
  totalBoxes: number;
  /** Compact "2×32 + 1×8" or empty when scu=0. */
  label: string;
}

/** Ceil to whole SCU for packing; non-finite / negative → 0. */
export function wholeScu(scu: number): number {
  if (!Number.isFinite(scu) || scu <= 0) return 0;
  return Math.ceil(scu - 1e-9);
}

/**
 * Greedy fewest-crate breakdown using STANDARD_CRATE_SCU.
 * Example: 64 → 2×32; 40 → 1×32 + 1×8; 31 → 1×24 + 1×4 + 1×2 + 1×1.
 */
export function calculateBoxes(scu: number): BoxBreakdown {
  let remaining = wholeScu(scu);
  const crates: BoxCount[] = [];
  for (const size of STANDARD_CRATE_SCU) {
    if (remaining < size) continue;
    const count = Math.floor(remaining / size);
    if (count > 0) {
      crates.push({ sizeScu: size, count });
      remaining -= count * size;
    }
  }
  // Safety: if anything left (shouldn't), fill with 1 SCU
  if (remaining > 0) {
    const one = crates.find((c) => c.sizeScu === 1);
    if (one) one.count += remaining;
    else crates.push({ sizeScu: 1, count: remaining });
    remaining = 0;
  }
  const totalBoxes = crates.reduce((a, c) => a + c.count, 0);
  return {
    scu: wholeScu(scu),
    crates,
    totalBoxes,
    label: formatBoxBreakdown(crates),
  };
}

/** "2×32 + 1×8" from crate counts. */
export function formatBoxBreakdown(crates: BoxCount[] | BoxBreakdown): string {
  const list = Array.isArray(crates) ? crates : crates.crates;
  if (list.length === 0) return "";
  return list.map((c) => `${c.count}×${c.sizeScu}`).join(" + ");
}

/** Footprint for a single crate size; undefined if not a standard size. */
export function boxFootprint(sizeScu: number): { w: number; d: number; cells: number } | undefined {
  if (!STANDARD_CRATE_SCU.includes(sizeScu as StandardCrateScu)) return undefined;
  return CRATE_FOOTPRINTS[sizeScu as StandardCrateScu];
}

/** True when this crate size fits a ship's max box (sc-trade maxBoxSizeInScu). */
export function fitsShipMaxBox(crateScu: number, maxBoxSizeInScu: number): boolean {
  if (!Number.isFinite(crateScu) || !Number.isFinite(maxBoxSizeInScu)) return false;
  if (maxBoxSizeInScu <= 0) return false;
  return crateScu <= maxBoxSizeInScu;
}

/** Largest standard crate that fits under maxBoxSizeInScu (0 if none). */
export function largestCrateThatFits(maxBoxSizeInScu: number): number {
  if (!Number.isFinite(maxBoxSizeInScu) || maxBoxSizeInScu <= 0) return 0;
  for (const size of STANDARD_CRATE_SCU) {
    if (size <= maxBoxSizeInScu) return size;
  }
  return 0;
}

/**
 * Whether the full volume can be packed into crates that all fit the ship max box.
 * Uses only crate sizes ≤ maxBoxSizeInScu.
 */
export function volumeFitsShip(scu: number, maxBoxSizeInScu: number): boolean {
  const maxCrate = largestCrateThatFits(maxBoxSizeInScu);
  if (maxCrate <= 0) return false;
  const need = wholeScu(scu);
  if (need === 0) return true;
  // If we can only use crates ≤ maxCrate, we can always fill with 1s if 1 fits.
  return maxCrate >= 1 && need >= 0;
}

/** Format amount with box label: "64 SCU (2×32)". Omits parens when empty. */
export function formatScuWithBoxes(scu: number): string {
  const n = Number.isFinite(scu) ? scu : 0;
  const amt = Number.isInteger(n) ? String(n) : String(n);
  const boxes = calculateBoxes(n);
  if (!boxes.label) return `${amt} SCU`;
  return `${amt} SCU (${boxes.label})`;
}

/** JSON-friendly summary for API / dashboard. */
export function boxSummary(scu: number): {
  scu: number;
  label: string;
  totalBoxes: number;
  crates: BoxCount[];
  largestCrate: number;
} {
  const b = calculateBoxes(scu);
  return {
    scu: b.scu,
    label: b.label,
    totalBoxes: b.totalBoxes,
    crates: b.crates,
    largestCrate: b.crates[0]?.sizeScu ?? 0,
  };
}
