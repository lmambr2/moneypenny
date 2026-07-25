/**
 * Minimal YAML-ish frontmatter parser for doctrine docs (ROADMAP Phase 6). Reads
 * a leading `---\n…\n---` block and pulls the fields the RAG layer cares about —
 * `classification` (for rank-gating), `tags`, `valid_until` — then returns the
 * remaining markdown body. Deliberately tiny (no YAML dependency): supports
 * `key: value` and inline `[a, b]` / comma lists, which is all doctrine needs.
 */

export interface DocFrontmatter {
  classification: string;
  tags: string[];
  validUntil?: string;
  /** The markdown body with the frontmatter block stripped. */
  body: string;
}

const FM_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

const METADATA_KEYS = new Set(["classification", "tags", "valid_until", "validuntil"]);

export function parseFrontmatter(raw: string): DocFrontmatter {
  const text = (raw ?? "").replace(/^﻿/, "");
  const m = text.match(FM_RE);
  if (m) {
    const fields = parseBlock(m[1]);
    const body = text.slice(m[0].length);
    return frontmatterFromFields(fields, body);
  }

  const loose = parseLooseLeadingMetadata(text);
  if (loose) return loose;

  return { classification: "unclassified", tags: [], body: text };
}

function frontmatterFromFields(fields: Record<string, string>, body: string): DocFrontmatter {
  return {
    classification: normClassification(fields.classification),
    tags: parseList(fields.tags),
    validUntil: fields.valid_until || fields.validuntil || undefined,
    body,
  };
}

/**
 * Accept metadata lines at the top without `---` fences (common hand-authored docs):
 *
 *   classification: secret
 *   tags: [fleet-ops]
 *
 *   # Title
 */
function parseLooseLeadingMetadata(text: string): DocFrontmatter | null {
  const lines = text.split(/\r?\n/);
  const fields: Record<string, string> = {};
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      i++;
      continue;
    }
    if (trimmed.startsWith("#")) break;

    const idx = trimmed.indexOf(":");
    if (idx === -1) break;
    const key = trimmed.slice(0, idx).trim().toLowerCase();
    if (!METADATA_KEYS.has(key)) break;

    fields[key] = stripQuotes(trimmed.slice(idx + 1).trim());
    i++;
  }

  if (!fields.classification && !fields.tags && !fields.valid_until && !fields.validuntil) {
    return null;
  }

  while (i < lines.length && !lines[i].trim()) i++;
  return frontmatterFromFields(fields, lines.slice(i).join("\n"));
}

function parseBlock(block: string): Record<string, string> {
  // Null-prototype: keys come from uploaded doctrine markdown, so `__proto__`
  // / `constructor` / `prototype` would otherwise write through to Object's
  // prototype chain instead of becoming plain fields
  // (CodeQL js/remote-property-injection).
  const out: Record<string, string> = Object.create(null);
  for (const line of block.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const idx = t.indexOf(":");
    if (idx === -1) continue;
    const key = t.slice(0, idx).trim().toLowerCase();
    const val = stripQuotes(t.slice(idx + 1).trim());
    if (key) out[key] = val;
  }
  return out;
}

/** Parse `[a, b]` or `a, b` into a trimmed, lowercased token list. */
function parseList(val?: string): string[] {
  if (!val) return [];
  return val
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => stripQuotes(s.trim()).toLowerCase())
    .filter(Boolean);
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]|['"]$/g, "");
}

/** Normalize a classification token; empty/missing → unclassified. */
function normClassification(val?: string): string {
  const c = stripQuotes((val ?? "").trim()).toLowerCase();
  return c || "unclassified";
}

/** Whether parsed frontmatter matches the doctrine registry row (for skip-reindex). */
export function metadataMatchesRegistry(
  fm: Pick<DocFrontmatter, "classification" | "tags" | "validUntil">,
  existing: { classification: string; tags: string[]; validUntil?: string },
): boolean {
  if (fm.classification !== existing.classification) return false;
  if ((fm.validUntil ?? "") !== (existing.validUntil ?? "")) return false;
  const a = [...fm.tags].sort();
  const b = [...existing.tags].sort();
  return a.length === b.length && a.every((t, i) => t === b[i]);
}
