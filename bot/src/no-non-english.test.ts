import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * English-only SOURCE guard (project policy). The codebase + UI must contain no
 * non-English script text — this catches de-sinicization leftovers and any
 * agent (human or AI) sneaking foreign-language strings/comments back in.
 *
 * NOTE: this scans SOURCE ONLY. Runtime DATA (e.g. a Japanese/Korean YouTube
 * song title in play history) is never touched and is perfectly fine — only
 * what we *write* must be English.
 */

// Letter ranges for major non-Latin scripts (CJK, kana, hangul, fullwidth forms,
// Cyrillic, Arabic, Hebrew, Thai). Emoji (astral plane) and symbols (▶ ⬆ ✕ 📎)
// are intentionally NOT matched — those are fine.
const NON_ENGLISH = /[Ѐ-ӿ֐-׿؀-ۿ฀-๿　-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;

/** Resolve `\uXXXX` / `\u{XXXX}` escapes so hidden CJK cannot evade the guard. */
function decodeUnicodeEscapes(line: string): string {
  return line.replace(
    /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g,
    (_m, braced: string, four: string) => {
      const code = Number.parseInt(braced ?? four, 16);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return _m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return _m;
      }
    },
  );
}

function lineHasNonEnglish(line: string): boolean {
  if (NON_ENGLISH.test(line)) return true;
  return NON_ENGLISH.test(decodeUnicodeEscapes(line));
}

const ROOTS = [path.join(process.cwd(), "src"), path.join(process.cwd(), "web", "src")];
const SKIP_FILES = new Set(["no-non-english.test.ts"]); // this file names the ranges above

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      yield* walk(full);
    } else if (/\.(ts|tsx|js|vue|css|html|json)$/.test(name) && !SKIP_FILES.has(name)) {
      yield full;
    }
  }
}

describe("English-only source policy", () => {
  it("contains no non-English script text anywhere in source", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const lines = readFileSync(file, "utf-8").split("\n");
        lines.forEach((line, i) => {
          if (lineHasNonEnglish(line)) {
            offenders.push(
              `${path.relative(process.cwd(), file)}:${i + 1}: ${line.trim().slice(0, 80)}`,
            );
          }
        });
      }
    }
    expect(offenders, `non-English text found in source:\n${offenders.join("\n")}`).toEqual([]);
  });
});
