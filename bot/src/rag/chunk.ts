import { createHash } from "node:crypto";

/**
 * Markdown chunking for RAG (ROADMAP Phase 5/6).
 * Heading-based + size-capped with overlap. Deterministic IDs for clean re-ingest.
 * See DESIGN.md for rationale and Phase 6 stable IDs.
 */

export interface Chunk {
  /** Deterministic, UUID-shaped (Qdrant point ids must be uint64 or UUID). */
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

const DEFAULTS: Required<ChunkOptions> = { maxChars: 1200, overlap: 150 };

/** Deterministic UUID id for a chunk (source+index). Enables clean replace on re-ingest. */
export function chunkId(source: string, index: number): string {
  const h = createHash("sha1").update(`${source}#${index}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Split md on headings, then size-cap sections with overlap.
 * See DESIGN for details.
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
      const breakAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"), slice.lastIndexOf(". "));
      if (breakAt > maxChars * 0.5) end = start + breakAt + 1;
    }
    out.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}
