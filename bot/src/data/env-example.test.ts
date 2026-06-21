import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for the env_file inline-comment pitfall: compose folds a
 * trailing `# comment` into the value when the value is empty (`FOO=  # x`
 * becomes FOO="# x"), silently corrupting the setting. `.env.example` must keep
 * comments on their own lines. (See the header comment in .env.example.)
 */
describe(".env.example", () => {
  it("has no inline '# comment' after a value on an active line", () => {
    const path = fileURLToPath(new URL("../../../.env.example", import.meta.url));
    const lines = readFileSync(path, "utf-8").split(/\r?\n/);
    const offenders: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue; // blank / comment / non-assignment
      const value = line.slice(line.indexOf("=") + 1);
      if (/\s#/.test(value)) offenders.push(line); // value contains " #" → inline comment
    }
    expect(offenders).toEqual([]);
  });
});
