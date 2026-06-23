/** Parse `from:`, `until:`, `asof:`, and `diary:` tokens from KG command text. */
export interface KgDateFlags {
  text: string;
  from?: string;
  until?: string;
  asOf?: string;
  diary?: "intel" | "logistics";
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [, y, m, d] = s.match(DATE_RE)!;
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return dt.getUTCFullYear() === Number(y) && dt.getUTCMonth() === Number(m) - 1 && dt.getUTCDate() === Number(d);
}

/** Strip inline flags; returns cleaned text + parsed values. */
export function parseKgFlags(raw: string): KgDateFlags {
  let text = raw.trim();
  const out: KgDateFlags = { text };

  const pull = (re: RegExp, key: keyof KgDateFlags) => {
    const m = text.match(re);
    if (!m) return;
    const val = m[1].trim();
    if (key === "diary") {
      const d = val.toLowerCase();
      if (d === "intel" || d === "logistics") out.diary = d;
    } else if (isIsoDate(val)) {
      (out as Record<string, string>)[key] = val;
    }
    text = text.replace(m[0], " ").replace(/\s+/g, " ").trim();
  };

  pull(/\bfrom:(\S+)/i, "from");
  pull(/\buntil:(\S+)/i, "until");
  pull(/\basof:(\S+)/i, "asOf");
  pull(/\bdiary:(\S+)/i, "diary");

  out.text = text;
  return out;
}

/** Best-effort subject for temporal lookup — "Alice was X" → "Alice". */
export function extractSubject(fact: string): string {
  const t = fact.trim();
  const was = t.match(/^(.+?)\s+was\s+/i);
  if (was) return was[1].trim();
  const held = t.match(/^(.+?)\s+held\s+/i);
  if (held) return held[1].trim();
  const is = t.match(/^(.+?)\s+is\s+(?:the\s+)?/i);
  if (is && is[1].split(/\s+/).length <= 4) return is[1].trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]} ${words[1]}`;
  return words[0] ?? t.slice(0, 80);
}

/** True when a fact is valid at `asOf` (inclusive calendar days, UTC). */
export function isFactActiveAt(
  validFrom: string | null | undefined,
  validUntil: string | null | undefined,
  asOf: string,
): boolean {
  if (!isIsoDate(asOf)) return true;
  if (validFrom && isIsoDate(validFrom)) {
    const start = Date.UTC(
      Number(validFrom.slice(0, 4)),
      Number(validFrom.slice(5, 7)) - 1,
      Number(validFrom.slice(8, 10)),
    );
    const ref = Date.UTC(
      Number(asOf.slice(0, 4)),
      Number(asOf.slice(5, 7)) - 1,
      Number(asOf.slice(8, 10)),
    );
    if (ref < start) return false;
  }
  if (validUntil && isIsoDate(validUntil)) {
    const end = Date.UTC(
      Number(validUntil.slice(0, 4)),
      Number(validUntil.slice(5, 7)) - 1,
      Number(validUntil.slice(8, 10)),
      23,
      59,
      59,
      999,
    );
    const ref = Date.UTC(
      Number(asOf.slice(0, 4)),
      Number(asOf.slice(5, 7)) - 1,
      Number(asOf.slice(8, 10)),
      12,
    );
    if (ref > end) return false;
  }
  return true;
}

/** Canonical storage / MemPalace document line. */
export function formatKgRecord(opts: {
  subject: string;
  fact: string;
  validFrom?: string | null;
  validUntil?: string | null;
  diary?: string | null;
}): string {
  const parts = [`@subject:${opts.subject.trim()}`];
  if (opts.validFrom) parts.push(`@from:${opts.validFrom}`);
  if (opts.validUntil) parts.push(`@until:${opts.validUntil}`);
  if (opts.diary) parts.push(`@diary:${opts.diary}`);
  return `${parts.join(" ")} | ${opts.fact.trim()}`;
}

export function displayFactLine(fact: string, validFrom?: string | null, validUntil?: string | null): string {
  const span: string[] = [];
  if (validFrom) span.push(`from ${validFrom}`);
  if (validUntil) span.push(`until ${validUntil}`);
  return span.length > 0 ? `${fact} (${span.join(", ")})` : fact;
}