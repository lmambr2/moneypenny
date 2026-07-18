/**
 * Parse / generate doctrine Ship_List.md (org fleet projection for RAG).
 *
 * Line shapes:
 *   - **(GCV)** Polaris - LTI `#capital #missile`
 *   - **(GCV)** 5× Aurora MK I SE
 *   - **(TER)** Paladin `#tank #heavy`
 */

export interface ShipListEntry {
  callsign: string;
  shipName: string;
  qty: number;
  notes: string | null;
  section: string;
}

const LINE_RE = /^\s*-\s*\*\*\(([^)]+)\)\*\*\s+(?:(\d+)\s*[x×]\s*)?(.+)$/i;

/** Strip tags / LTI / italics from a raw ship line tail. */
export function cleanShipName(raw: string): { name: string; notes: string | null } {
  let s = String(raw || "").trim();
  // Drop trailing hashtag clusters (with optional backticks around them)
  s = s.replace(/\s*`?#(?:[\w-]+)(?:\s+#(?:[\w-]+))*`?\s*$/g, "").trim();
  s = s.replace(/`+/g, "").trim();
  // Italic parenthetical notes: *(New — …)*
  s = s.replace(/\s*\*+[^*]*\*+\s*$/g, "").trim();
  // " - LTI …" → notes
  let notes: string | null = null;
  const lti = s.match(/^(.*?)\s+-\s+(LTI\b.*)$/i);
  if (lti) {
    s = lti[1]!.trim();
    notes = lti[2]!.trim();
  }
  // Parenthetical notes left on name: (Laser + Missile AA)
  return { name: s.trim(), notes };
}

/** Parse hangar lines from Ship_List.md body. */
export function parseShipListMarkdown(md: string): ShipListEntry[] {
  const entries: ShipListEntry[] = [];
  let section = "General";
  for (const raw of md.split(/\r?\n/)) {
    const heading = raw.match(/^#{2,3}\s+(.+)/);
    if (heading) {
      section = heading[1]!.trim();
      continue;
    }
    const m = raw.match(LINE_RE);
    if (!m) continue;
    const callsign = m[1]!.trim().toUpperCase();
    const qty = m[2] ? Math.max(1, parseInt(m[2], 10) || 1) : 1;
    const cleaned = cleanShipName(m[3]!);
    if (!cleaned.name) continue;
    entries.push({
      callsign,
      shipName: cleaned.name,
      qty,
      notes: cleaned.notes,
      section,
    });
  }
  return entries;
}

export interface ShipListExportRow {
  callsign: string;
  displayName: string | null;
  shipName: string;
  qty: number;
  notes: string | null;
}

/** Build secret-classified Ship_List.md from hangar rows. */
export function generateShipListMarkdown(rows: ShipListExportRow[], now = new Date()): string {
  const byCs = new Map<string, ShipListExportRow[]>();
  for (const r of rows) {
    const cs = (r.callsign || "?").toUpperCase();
    const list = byCs.get(cs) ?? [];
    list.push(r);
    byCs.set(cs, list);
  }
  const codes = [...byCs.keys()].sort();
  let total = 0;
  for (const r of rows) total += r.qty;

  const lines: string[] = [
    "---",
    "classification: secret",
    "tags: [intel, fleet-ops]",
    "---",
    "",
    "# Org Fleet List",
    `**Last Updated:** ${now.toISOString().slice(0, 10)}`,
    `**Source:** hangar DB (auto)`,
    `**Total Ships:** ~${total}`,
    `**Members with hangars:** ${codes.length}`,
    "",
    "## By member",
    "",
  ];

  for (const cs of codes) {
    const ships = byCs.get(cs)!;
    const label = ships[0]?.displayName ? `${cs} — ${ships[0].displayName}` : cs;
    lines.push(`### (${cs}) ${label}`);
    for (const s of ships.sort((a, b) => a.shipName.localeCompare(b.shipName))) {
      const qtyPrefix = s.qty > 1 ? `${s.qty}× ` : "";
      const note = s.notes ? ` - ${s.notes}` : "";
      lines.push(`- **(${cs})** ${qtyPrefix}${s.shipName}${note}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("**Notes:**");
  lines.push("- Generated from `!ships` hangar data — edit via hangar commands, then reindex.");
  lines.push("- LTI and pledge notes preserved when present.");
  lines.push("- Classification **secret** — rank-gated doctrine retrieval.");
  lines.push("");

  return lines.join("\n");
}
