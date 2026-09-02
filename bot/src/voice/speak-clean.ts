import { applySpeakLexicon } from "./org-lexicon.js";

/**
 * Strip markdown / citation chrome and expand the org lexicon so Piper never
 * reads `**bold**`, bullet glyphs, or `📎 Sources:`. Spoken prompt ≠ !ask prompt.
 */

const CODE_FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`([^`]+)`/g;
const MD_LINK = /\[([^\]]+)\]\([^)]+\)/g;
const HEADING = /^\s{0,3}#{1,6}\s+/gm;
const BULLET = /^\s{0,3}(?:[-*+]|•|\d+[.)])\s+/gm;
const BOLD_ITALIC = /[*_]{1,3}([^*_]+)[*_]{1,3}/g;
const SOURCES_FOOTER = /(?:\n{1,2})?(?:📎\s*)?Sources:.*$/is;

export function stripMarkdownForSpeech(raw: string): string {
  let t = raw.replace(/\r\n/g, "\n");
  t = t.replace(SOURCES_FOOTER, "");
  t = t.replace(CODE_FENCE, " ");
  t = t.replace(INLINE_CODE, "$1");
  t = t.replace(MD_LINK, "$1");
  t = t.replace(HEADING, "");
  t = t.replace(BULLET, "");
  t = t.replace(BOLD_ITALIC, "$1");
  t = t.replace(/https?:\/\/\S+/gi, " ");
  t = t.replace(/[|#>~]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/** Full spoken form: strip chrome, then expand 600i / INTSUM / ranks. */
export function textToSpoken(raw: string): string {
  return applySpeakLexicon(stripMarkdownForSpeech(raw)).replace(/\s+/g, " ").trim();
}

/**
 * Pull complete sentences off a growing buffer (LLM stream).
 * Leaves a trailing fragment in `rest` until terminal punctuation or flush.
 */
export function splitCompleteSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  // Split on . ! ? (and unicode …) followed by space or end — keep the mark.
  const re = /(.+?[.!?…]+)(?:\s+|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest))) {
    const piece = m[1]!.trim();
    if (piece) sentences.push(piece);
    last = m.index + m[0].length;
  }
  rest = rest.slice(last);
  return { sentences, rest };
}

/** Split a finished reply into speakable sentences (flush leftover). */
export function splitSpokenSentences(text: string): string[] {
  const spoken = textToSpoken(text);
  if (!spoken) return [];
  const { sentences, rest } = splitCompleteSentences(spoken);
  if (rest.trim()) sentences.push(rest.trim());
  return sentences.filter(Boolean);
}
