import { describe, expect, it } from "vitest";
import { chunkId, chunkMarkdown } from "./chunk.js";

describe("chunkId", () => {
  it("is deterministic and UUID-shaped (Qdrant point id)", () => {
    const a = chunkId("doc.md", 0);
    expect(chunkId("doc.md", 0)).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
  it("differs by source and index", () => {
    expect(chunkId("doc.md", 0)).not.toBe(chunkId("doc.md", 1));
    expect(chunkId("a.md", 0)).not.toBe(chunkId("b.md", 0));
  });
});

describe("chunkMarkdown", () => {
  it("returns nothing for empty/whitespace", () => {
    expect(chunkMarkdown("s", "")).toEqual([]);
    expect(chunkMarkdown("s", "   \n  ")).toEqual([]);
  });

  it("splits on markdown headings, one chunk per small section", () => {
    const md = "# Doctrine\nIntro line.\n## Alpha\nAlpha body.\n## Bravo\nBravo body.";
    const chunks = chunkMarkdown("doctrine.md", md);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].text).toContain("# Doctrine");
    expect(chunks[1].text).toContain("## Alpha");
    expect(chunks[2].text).toContain("## Bravo");
    // sequential index + source carried through
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(chunks.every((c) => c.source === "doctrine.md")).toBe(true);
  });

  it("size-splits a section larger than maxChars", () => {
    const big = `## Big\n${"word ".repeat(200)}`; // ~1000+ chars under one heading
    const chunks = chunkMarkdown("big.md", big, { maxChars: 300, overlap: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 300 + 1)).toBe(true);
  });

  it("handles plain text (no headings) as a single section", () => {
    const chunks = chunkMarkdown("note.txt", "just a short note");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("just a short note");
  });

  it("ids are stable across re-chunking the same source (clean re-ingest)", () => {
    const md = "# A\nbody a\n# B\nbody b";
    const first = chunkMarkdown("x.md", md);
    const second = chunkMarkdown("x.md", md);
    expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id));
  });
});
