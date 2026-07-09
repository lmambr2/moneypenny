/** Promote a generated bumper into the prerecorded pool (docs/radio.md §6.5). */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";

export interface LastPlayedBumper {
  path: string;
  label?: string;
}

const AUDIO_EXT = new Set([".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".opus", ".webm"]);

/** Copy the last played bumper audio into the prerecorded assets directory. */
export function pinBumperToPool(
  last: LastPlayedBumper | null,
  bumperDir: string,
  now = Date.now,
): { ok: true; dest: string } | { ok: false; error: string } {
  if (!last?.path) return { ok: false, error: "no bumper has been played yet" };
  if (!existsSync(last.path)) return { ok: false, error: "last bumper file is gone" };
  const ext = extname(last.path).toLowerCase();
  if (!AUDIO_EXT.has(ext)) return { ok: false, error: "last bumper is not a supported audio file" };

  mkdirSync(bumperDir, { recursive: true });
  const slug =
    (last.label ?? "bumper").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "bumper";
  const base = `${slug}-${now()}`;
  let dest = join(bumperDir, `${base}${ext}`);
  let n = 0;
  while (existsSync(dest)) {
    n += 1;
    dest = join(bumperDir, `${base}-${n}${ext}`);
  }
  try {
    copyFileSync(last.path, dest);
    return { ok: true, dest };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "copy failed" };
  }
}

/** True when `path` already lives under the prerecorded bumper directory. */
export function isUnderBumperDir(path: string, bumperDir: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const p = norm(path);
  const dir = norm(bumperDir).replace(/\/$/, "");
  return p === dir || p.startsWith(`${dir}/`);
}
