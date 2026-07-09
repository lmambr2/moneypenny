/**
 * TS6-safe unstable material flags (emoji — no BBCode color).
 * Critical / volatile ores from seed catalog (e.g. Quantainium, Stileron).
 */
import { findOre, type Stability } from "./catalog.js";

/** Shown after material names that need a refine clock / careful handling. */
export const UNSTABLE_EMOJI = "⚠️";

export function stabilityOfMaterial(name: string): Stability | null {
  const raw = String(name || "").trim();
  if (!raw) return null;
  // Strip "refined " prefix if present
  const cleaned = raw.replace(/^refined\s+/i, "").trim();
  const ore = findOre(cleaned) ?? findOre(raw);
  if (ore) return ore.stability;
  // Fallback name match for sc-craft labels
  if (/quantainium|quantanium/i.test(raw)) return "critical";
  return null;
}

/** True when material is volatile or critical (Quantainium etc.). */
export function isUnstableMaterial(name: string): boolean {
  const s = stabilityOfMaterial(name);
  return s === "critical" || s === "volatile";
}

/** Append " ⚠️" for unstable materials; empty string otherwise. */
export function unstableFlag(name: string): string {
  return isUnstableMaterial(name) ? ` ${UNSTABLE_EMOJI}` : "";
}

/** Format a single material token with optional flag. */
export function formatMaterialName(name: string): string {
  return `${name}${unstableFlag(name)}`;
}
