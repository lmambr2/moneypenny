/**
 * Reformat doctrine Markdown for heading-aware RAG chunks + human readability.
 * Port of scripts/reformat-doctrine-corpus.py (keep behavior in sync).
 */

const FM_RE = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/;
const META_KEY_RE = /^(classification|tags|valid_until|validuntil)\s*:\s*(.*)$/i;
const ROMAN_RE = /^((?:X{0,3})(?:IX|IV|V?I{0,3}))\.\s+([A-Z].{3,80})$/;
const NUM_TITLE_RE = /^(\d{1,2})\.\s+([A-Z][A-Za-z0-9 /&\-']{2,60})$/;

const SKIP_SUFFIXES = ["ops/rag-ingestion-cheatsheet.md", "ops-rank-gating.md"] as const;

const DENY_HEADING =
  /^(cui\b|noforn\b|top secret|secret|restricted|unclassified|end of statement|approved for public release|\d+x\s|standard manning|reduced manning|command ship|heavy strike|operational anchor|escort support|shield pressure|screening|interception|reconnaissance|rapid response|effective:|distance control|speed management|smart boost management|.*crew$|.*gunners?$|.*fighters?$)$/i;

const SECTION_TITLE =
  /^(purpose|mission|composition|doctrine|overview|procedure|requirements?|notes?|summary|background|scope|responsibilities|core functions|guiding principles|reporting and oversight|reporting|personnel requirement|standard doctrine|charter and mission statement|flexible squadron|wolfpack squadron|the infinity turn.*|the sliding strafe.*|power management.*|why pledge.*|what do i.*|logistics.*|security.*|aerospace.*|ground.*|support.*|leadership.*|casualty states)$/i;

export interface ReformatResult {
  source: string;
  changed: boolean;
  skipped?: boolean;
  reason?: string;
}

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, "");
  const m = text.match(FM_RE);
  if (m) {
    const fields: Record<string, string> = {};
    for (const line of m[1]!.split("\n")) {
      const km = line.trim().match(META_KEY_RE);
      if (km) {
        const key = km[1]!.toLowerCase().replace("validuntil", "valid_until");
        fields[key] = km[2]!.trim();
      }
    }
    return { fields, body: text.slice(m[0].length) };
  }

  const lines = text.split(/\r?\n/);
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const t = lines[i]!.trim();
    if (!t) {
      i++;
      continue;
    }
    if (t.startsWith("#")) break;
    const km = t.match(META_KEY_RE);
    if (!km) break;
    const key = km[1]!.toLowerCase().replace("validuntil", "valid_until");
    fields[key] = km[2]!.trim();
    i++;
  }
  while (i < lines.length && !lines[i]!.trim()) i++;
  return { fields, body: lines.slice(i).join("\n") };
}

function formatFrontmatter(fields: Record<string, string>): string {
  let classification = (fields.classification || "unclassified").replace(/\s+/g, "").toLowerCase();
  if (!classification) classification = "unclassified";
  const tags = (fields.tags || "").trim();
  const valid = (fields.valid_until || "").trim();
  const lines = ["---", `classification: ${classification}`];
  if (tags) lines.push(`tags: ${tags}`);
  if (valid) lines.push(`valid_until: ${valid}`);
  lines.push("---", "");
  return lines.join("\n");
}

function titleCaseBanner(s: string): string {
  const small = new Set([
    "a",
    "an",
    "the",
    "and",
    "or",
    "of",
    "to",
    "in",
    "for",
    "on",
    "with",
    "vs",
  ]);
  return s
    .trim()
    .split(/\s+/)
    .map((w, i) => {
      if (/^[A-Z0-9]{2,}(?:\/[A-Z0-9]+)*$/.test(w)) return w;
      const low = w.toLowerCase();
      if (i > 0 && small.has(low)) return low;
      if (w === w.toUpperCase() && w.length > 1) return w[0]! + w.slice(1).toLowerCase();
      return w;
    })
    .join(" ");
}

function isAllCapsBanner(t: string): boolean {
  const letters = [...t].filter((c) => /[a-zA-Z]/.test(c));
  if (letters.length < 4) return false;
  return letters.filter((c) => c === c.toUpperCase()).length / letters.length > 0.9;
}

function looksLikeHeading(line: string, prev: string, nxt: string | null): boolean {
  const t = line.trim();
  if (!t || t.startsWith("#") || t.startsWith("---")) return false;
  if (/^[-*>|(]/.test(t)) return false;
  if (t.length > 85 || t.length < 3) return false;
  if (DENY_HEADING.test(t)) return false;
  if (t.includes("//") && t.length < 40) return false;
  if (t.includes(":") && t.length > 25 && !NUM_TITLE_RE.test(t)) return false;

  if (ROMAN_RE.test(t)) return true;
  const num = t.match(NUM_TITLE_RE);
  if (num && num[2]!.split(/\s+/).length <= 6) return true;
  if (isAllCapsBanner(t) && !/[.!?]$/.test(t)) return true;

  if (/[.!?,;]$/.test(t)) return false;
  if (prev.trim() !== "") return false;

  if (SECTION_TITLE.test(t)) return true;

  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 10) return false;
  const caps = words.filter((w) => /^[A-Z]/.test(w)).length;
  if (caps < words.length * 0.7) return false;
  if (nxt != null) {
    const ns = nxt.trim();
    if (ns && ns.length < 40 && !/^[a-z]/.test(ns)) return false;
  }
  if (nxt && nxt.trim().length > 60) return true;
  return false;
}

function promoteHeading(line: string): string {
  const t = line.trim();
  const roman = t.match(ROMAN_RE);
  if (roman) return `## ${roman[2]!.trim()}`;
  const num = t.match(NUM_TITLE_RE);
  if (num) return `## ${titleCaseBanner(num[2]!.trim())}`;
  if (isAllCapsBanner(t)) return `## ${titleCaseBanner(t)}`;
  return `## ${t}`;
}

function reformatBody(body: string): string {
  let text = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/\u201c|\u201d/g, '"').replace(/\u2018|\u2019/g, "'");
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const stripped = line.trim();
    const prev = out.length ? out[out.length - 1]! : "";
    const nxt = i + 1 < lines.length ? lines[i + 1]! : null;

    if (!stripped) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (/^#{1,6}\s/.test(stripped)) {
      out.push(stripped);
      continue;
    }
    if (looksLikeHeading(stripped, prev, nxt)) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      out.push(promoteHeading(stripped));
      out.push("");
      continue;
    }
    const goodBad = line.match(/^\s+(Good For|Bad At):\s*(.+)$/i);
    if (goodBad) {
      out.push(
        `- **${goodBad[1]![0]!.toUpperCase()}${goodBad[1]!.slice(1).toLowerCase()}:** ${goodBad[2]!.trim()}`,
      );
      continue;
    }
    if (/^[ \t]{2,}\S/.test(line) && stripped.length < 80 && !stripped.endsWith(".")) {
      out.push(`- ${stripped}`);
      continue;
    }
    const lab = stripped.match(/^([A-Za-z][A-Za-z0-9 /&-]{1,32}):\s+(.{12,})$/);
    if (lab && !/http/i.test(stripped)) {
      if (prev === "" || prev.startsWith("#") || prev.startsWith("-")) {
        out.push(`- **${lab[1]}:** ${lab[2]}`);
        continue;
      }
    }
    out.push(stripped);
  }

  const cleaned: string[] = [];
  let blanks = 0;
  for (const ln of out) {
    if (ln === "") {
      blanks++;
      if (blanks <= 2) cleaned.push("");
    } else {
      blanks = 0;
      cleaned.push(ln);
    }
  }
  while (cleaned[0] === "") cleaned.shift();
  while (cleaned.length && cleaned[cleaned.length - 1] === "") cleaned.pop();
  cleaned.push("");
  return cleaned.join("\n");
}

function ensureTitle(body: string, filename: string): string {
  const stripped = body.replace(/^\s+/, "");
  if (stripped.startsWith("# ")) return body;
  const stem = filename
    .replace(/\.(md|markdown)$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!stem) return body;
  return `# ${stem}\n\n${stripped}`;
}

function bulletizeComposition(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let underComposition = false;
  for (const line of lines) {
    const s = line.trim();
    if (/^##\s+/.test(s)) {
      underComposition = /^##\s+composition/i.test(s);
      out.push(line);
      continue;
    }
    if (underComposition && s && !s.startsWith("#") && !s.startsWith("-") && !s.startsWith("*")) {
      if (/^\d+x\s/.test(s) || /^\d+[–-]\d+x\s/.test(s)) {
        out.push(`- ${s}`);
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/** Pure reformat of one markdown file. Returns null if unchanged / skip. */
export function reformatDoctrineMarkdown(raw: string, sourceName: string): string | null {
  const posix = sourceName.replace(/\\/g, "/");
  if (SKIP_SUFFIXES.some((s) => posix.endsWith(s))) return null;

  const { fields, body } = parseFrontmatter(raw);
  if (!fields.classification) fields.classification = "unclassified";
  let newBody = ensureTitle(reformatBody(body), sourceName.split("/").pop() || sourceName);
  newBody = bulletizeComposition(newBody);
  const newText = formatFrontmatter(fields) + newBody;
  const oldNorm = raw.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  if (newText === oldNorm) return null;
  return newText;
}

export function shouldSkipDoctrineReformat(source: string): boolean {
  const posix = source.replace(/\\/g, "/");
  return SKIP_SUFFIXES.some((s) => posix.endsWith(s));
}
