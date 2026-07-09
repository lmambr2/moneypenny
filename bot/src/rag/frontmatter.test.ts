import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses classification, tags (inline list), valid_until + strips the block", () => {
    const raw = `---\nclassification: Restricted\ntags: [intel, fleet-ops]\nvalid_until: 2026-12-31\n---\n# INTSUM\nBody line.`;
    const fm = parseFrontmatter(raw);
    expect(fm.classification).toBe("restricted");
    expect(fm.tags).toEqual(["intel", "fleet-ops"]);
    expect(fm.validUntil).toBe("2026-12-31");
    expect(fm.body).toBe("# INTSUM\nBody line.");
  });

  it("supports comma lists and quoted values", () => {
    const fm = parseFrontmatter(`---\nclassification: "secret"\ntags: alpha, "bravo"\n---\nbody`);
    expect(fm.classification).toBe("secret");
    expect(fm.tags).toEqual(["alpha", "bravo"]);
  });

  it("defaults to unclassified with no frontmatter", () => {
    const fm = parseFrontmatter("# Just markdown\nno frontmatter here");
    expect(fm.classification).toBe("unclassified");
    expect(fm.tags).toEqual([]);
    expect(fm.body).toBe("# Just markdown\nno frontmatter here");
  });

  it("defaults classification to unclassified if the field is absent", () => {
    const fm = parseFrontmatter(`---\ntags: [public]\n---\nhello`);
    expect(fm.classification).toBe("unclassified");
    expect(fm.tags).toEqual(["public"]);
    expect(fm.body).toBe("hello");
  });

  it("does not treat a mid-document --- as frontmatter", () => {
    const raw = "# Title\nsome text\n---\nnot frontmatter";
    const fm = parseFrontmatter(raw);
    expect(fm.classification).toBe("unclassified");
    expect(fm.body).toBe(raw);
  });

  it("parses loose leading metadata without --- fences (Ship_List style)", () => {
    const raw = `classification: secret
tags: [fleet-ops]

# Org Fleet List
- Polaris`;
    const fm = parseFrontmatter(raw);
    expect(fm.classification).toBe("secret");
    expect(fm.tags).toEqual(["fleet-ops"]);
    expect(fm.body).toBe(`# Org Fleet List
- Polaris`);
  });
});
