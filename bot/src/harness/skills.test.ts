import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkills, SKILL_MAX_FILE_BYTES, SKILL_MAX_FILES } from "./skills.js";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "mp-skills-"));
}

describe("loadSkills", () => {
  it("packs frontmatter skills and unions tools", () => {
    const root = dir();
    writeFileSync(join(root, "b.md"), "---\nname: b\ntools: [skip]\nmaxSteps: 2\n---\nSecond.");
    writeFileSync(
      join(root, "a.md"),
      "---\nname: hangar-dj\ntools: [play_music, skip]\nmaxSteps: 3\n---\nPrefer local.",
    );
    const loaded = loadSkills(root);
    expect(loaded.skills.map((s) => s.name)).toEqual(["hangar-dj", "b"]);
    expect(loaded.text).toMatch(/Prefer local/);
    expect(loaded.text).toMatch(/Second/);
    expect([...loaded.tools].sort()).toEqual(["play_music", "skip"]);
    expect(loaded.declaresTools).toBe(true);
    expect(loaded.maxSteps).toBe(2);
    expect(loaded.dropped).toEqual([]);
  });

  it("drops a file over the per-file cap instead of truncating it", () => {
    const root = dir();
    writeFileSync(join(root, "ok.md"), "---\nname: ok\n---\nKeep.");
    writeFileSync(join(root, "big.md"), "x".repeat(SKILL_MAX_FILE_BYTES + 8));
    const loaded = loadSkills(root);
    expect(loaded.skills.map((s) => s.name)).toEqual(["ok"]);
    expect(loaded.dropped).toEqual(["big.md"]);
    expect(loaded.text).not.toMatch(/x{20}/);
  });

  it("drops files past the count cap", () => {
    const root = dir();
    for (let i = 0; i < SKILL_MAX_FILES + 2; i++) {
      writeFileSync(join(root, `${i}.md`), `---\nname: s${i}\n---\nBody ${i}.`);
    }
    const loaded = loadSkills(root);
    expect(loaded.skills).toHaveLength(SKILL_MAX_FILES);
    expect(loaded.dropped).toHaveLength(2);
  });

  it("missing directory is empty", () => {
    const loaded = loadSkills(join(tmpdir(), "mp-skills-missing-nope"));
    expect(loaded.text).toBe("");
    expect(loaded.skills).toEqual([]);
  });
});
