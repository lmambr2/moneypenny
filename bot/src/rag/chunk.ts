import { createHash } from "node:crypto";

/**
 * Document chunking for the RAG substrate (ROADMAP Phase 5). Splits markdown into
 * heading-bounded, size-capped chunks with overlap, and assigns each a
 * deterministic id so re-ingesting a source replaces its chunks cleanly (this is
 * the seed of Phase 6's stable `path#section` chunk IDs).
 */

export interface Chunk {
  /** Deterministic, UUID-shaped (vector-store point ids must be uint64 or UUID). */
  id: string;
  text: string;
  source: string;
  index: number;
}

export interface ChunkOptions {
  /** Target max characters per chunk. */
  maxChars?: number;
  /** Character overlap carried between adjacent size-split chunks. */
  overlap?: number;
}

/**
 * English RAG defaults (~4 chars/token):
 * - maxChars 2048 ≈ 512 tokens (upper of 384–512 target band)
 * - overlap 200 ≈ 50 tokens
 */
export const DEFAULT_CHUNK_MAX_CHARS = 2048;
export const DEFAULT_CHUNK_OVERLAP = 200;

const DEFAULTS: Required<ChunkOptions> = {
  maxChars: DEFAULT_CHUNK_MAX_CHARS,
  overlap: DEFAULT_CHUNK_OVERLAP,
};

/**
 * Deterministic chunk id, formatted as a UUID string (vector store only accepts
 * uint64 or UUID point ids). Same source+index → same id → upsert replaces.
 */
export function chunkId(source: string, index: number): string {
  const h = createHash("sha1").update(`${source}#${index}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Chunk markdown: split on headings first (a section keeps its heading), then
 * size-bound any section that's too large. Plain text falls through the same
 * path (no headings → one section → size split).
 */
export function chunkMarkdown(source: string, md: string, opts: ChunkOptions = {}): Chunk[] {
  const { maxChars, overlap } = { ...DEFAULTS, ...opts };
  const text = (md ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  const pieces: string[] = [];
  for (const section of splitByHeading(text)) {
    if (section.length <= maxChars) pieces.push(section);
    else pieces.push(...sizeChunks(section, maxChars, overlap));
  }

  return pieces
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t, i) => ({ id: chunkId(source, i), text: t, source, index: i }));
}

/** Alias for non-markdown text (same heading-aware path, harmlessly). */
export function chunkText(source: string, text: string, opts: ChunkOptions = {}): Chunk[] {
  return chunkMarkdown(source, text, opts);
}

function splitByHeading(text: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    if (/^#{1,6}\s/.test(line) && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return sections.length > 0 ? sections : [text];
}

function sizeChunks(text: string, maxChars: number, overlap: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      // Prefer a clean break (paragraph > line > sentence) in the back half.
      const slice = text.slice(start, end);
      const breakAt = Math.max(
        slice.lastIndexOf("\n\n"),
        slice.lastIndexOf("\n"),
        slice.lastIndexOf(". "),
      );
      if (breakAt > maxChars * 0.5) end = start + breakAt + 1;
    }
    out.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}
