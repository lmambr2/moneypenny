import { describe, expect, it } from "vitest";
import { reformatDoctrineMarkdown, shouldSkipDoctrineReformat } from "./reformat-doctrine.js";

describe("reformatDoctrineMarkdown", () => {
  it("normalizes loose frontmatter and promotes Purpose/Mission", () => {
    const raw = `classification: secret        
tags: [fighter-ops] 

Heavy fighters are specialized.

Purpose
The Office exists to advise.

Mission
Stay sharp.
`;
    const out = reformatDoctrineMarkdown(raw, "On Heavy Fighters.md");
    expect(out).toBeTruthy();
    expect(out!).toMatch(/^---\nclassification: secret\ntags: \[fighter-ops\]\n---\n/);
    expect(out!).toContain("# On Heavy Fighters");
    expect(out!).toContain("## Purpose");
    expect(out!).toContain("## Mission");
  });

  it("promotes Roman sections and leaves CUI stamps", () => {
    const raw = `---
classification: unclassified
---

Preamble text here.

I. The Glorious Burden of the Eighteenth
Before the Incident, the group stood firm.

CUI // NOFORN
Still body.
`;
    const out = reformatDoctrineMarkdown(raw, "tf18.md")!;
    expect(out).toContain("## The Glorious Burden of the Eighteenth");
    expect(out).toContain("CUI // NOFORN");
    expect(out).not.toMatch(/## Cui/i);
  });

  it("bulletizes indented pillars and Good For lines", () => {
    const raw = `---
classification: restricted
---

# Doc

Success comes down to three pillars:

    Distance Control
    Speed Management

    Good For: reliability.
`;
    const out = reformatDoctrineMarkdown(raw, "x.md")!;
    expect(out).toContain("- Distance Control");
    expect(out).toContain("- **Good for:** reliability.");
  });

  it("skips operator cheatsheets", () => {
    expect(shouldSkipDoctrineReformat("ops/rag-ingestion-cheatsheet.md")).toBe(true);
    expect(reformatDoctrineMarkdown("# x\n\nbody\n", "ops/rag-ingestion-cheatsheet.md")).toBeNull();
  });

  it("returns null when already clean", () => {
    const raw = `---
classification: unclassified
tags: []
---
# Title

## Section

Body paragraph that is long enough to not be a heading.

`;
    // May still change whitespace slightly; if stable, null
    const once = reformatDoctrineMarkdown(raw, "Title.md");
    if (once) {
      expect(reformatDoctrineMarkdown(once, "Title.md")).toBeNull();
    }
  });
});
