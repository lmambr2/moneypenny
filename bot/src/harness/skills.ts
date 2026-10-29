/**
 * Static operator skills (PR-H2). Markdown dropped in bot/data/skills/.
 * Always injected on AgentRuntime paths. No `when:` router. No P3 capture.
 * Caps: 4 files, 2 KiB each, 6 KiB total. Overflow drops whole files.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SKILL_MAX_FILES = 4;
export const SKILL_MAX_FILE_BYTES = 2 * 1024;
export const SKILL_MAX_TOTAL_BYTES = 6 * 1024;

export interface SkillDoc {
  name: string;
  file: string;
  tools: string[];
  maxSteps?: number;
  body: string;
}

export interface LoadedSkills {
  /** Packed system text. Empty when nothing loaded. */
  text: string;
  /** Union of frontmatter `tools`. Empty set when no file declared any. */
  tools: Set<string>;
  /** True when at least one file listed tools — intersect channel policy. */
  declaresTools: boolean;
  /** Lowest frontmatter maxSteps, if any. */
  maxSteps?: number;
  dropped: string[];
  skills: SkillDoc[];
}

const EMPTY: LoadedSkills = {
  text: "",
  tools: new Set(),
  declaresTools: false,
  dropped: [],
  skills: [],
};

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { meta: {}, body: text.trim() };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: text.trim() };
  const block = text.slice(3, end).trim();
  const body = text.slice(end + 4).trim();
  const meta: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body };
}

function parseTools(raw: string | undefined): string[] {
  if (!raw) return [];
  const inner = raw.replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * Load skills from a directory. Missing dir is empty, not an error.
 * Files that exceed a cap are logged via `dropped` and omitted whole.
 */
export function loadSkills(dir: string, log?: (msg: string) => void): LoadedSkills {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".md") && !n.endsWith(".example.md"))
      .sort();
  } catch {
    return { ...EMPTY, tools: new Set() };
  }

  const skills: SkillDoc[] = [];
  const dropped: string[] = [];
  const tools = new Set<string>();
  let declaresTools = false;
  let maxSteps: number | undefined;
  let total = 0;

  for (const file of names) {
    if (skills.length >= SKILL_MAX_FILES) {
      dropped.push(file);
      log?.(`skill dropped (max ${SKILL_MAX_FILES} files): ${file}`);
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(join(dir, file), "utf8");
    } catch {
      dropped.push(file);
      continue;
    }
    const bytes = Buffer.byteLength(raw, "utf8");
    if (bytes > SKILL_MAX_FILE_BYTES) {
      dropped.push(file);
      log?.(`skill dropped (over ${SKILL_MAX_FILE_BYTES} bytes): ${file}`);
      continue;
    }
    if (total + bytes > SKILL_MAX_TOTAL_BYTES) {
      dropped.push(file);
      log?.(`skill dropped (over ${SKILL_MAX_TOTAL_BYTES} total): ${file}`);
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    if (!body.trim()) {
      dropped.push(file);
      log?.(`skill dropped (empty body): ${file}`);
      continue;
    }
    const listed = parseTools(meta.tools);
    if (listed.length) declaresTools = true;
    for (const t of listed) tools.add(t);
    const steps = Number(meta.maxSteps);
    if (Number.isFinite(steps) && steps > 0) {
      maxSteps = maxSteps === undefined ? steps : Math.min(maxSteps, steps);
    }
    total += bytes;
    skills.push({
      name: meta.name || file.replace(/\.md$/, ""),
      file,
      tools: listed,
      maxSteps: Number.isFinite(steps) && steps > 0 ? steps : undefined,
      body: body.trim(),
    });
  }

  const text = skills
    .map((s) => `## ${s.name}\n${s.body}`)
    .join("\n\n")
    .trim();
  return { text, tools, declaresTools, maxSteps, dropped, skills };
}
