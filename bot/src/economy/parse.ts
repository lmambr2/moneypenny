/**
 * Shared arg parsing for !mine / !refine / !craft / !econ.
 *
 * Flags as tokens: scu:32, qty:4, method:cormack
 * Leading free-text is the ore / recipe name (may be multi-word until first key:).
 */

export interface EconomyFlags {
  /** Free-text subject (ore, recipe, or econ subcommand rest). */
  subject: string;
  scu?: number;
  qty?: number;
  method?: string;
}

const KEY_RE = /^(scu|qty|method|m):(.+)$/i;

export function parseEconomyArgs(args: string): EconomyFlags {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const subjectParts: string[] = [];
  let scu: number | undefined;
  let qty: number | undefined;
  let method: string | undefined;

  for (const p of parts) {
    const m = KEY_RE.exec(p);
    if (!m) {
      subjectParts.push(p);
      continue;
    }
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === "scu") {
      const n = Number(val);
      if (Number.isFinite(n) && n > 0) scu = n;
    } else if (key === "qty") {
      const n = Number(val);
      if (Number.isFinite(n) && n > 0) qty = n;
    } else if (key === "method" || key === "m") {
      method = val;
    }
  }

  return {
    subject: subjectParts.join(" ").trim(),
    scu,
    qty,
    method,
  };
}
