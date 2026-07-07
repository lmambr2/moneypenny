/**
 * library-tag-scan.ts — OQ3 measurement (radio.md §15.3 / §9.5).
 *
 * Counts embedded genre/BPM/key/mood/subgenre tags in a music library.
 * Read-only; uses the same extensions as LocalProvider.
 *
 * Dev:  cd bot && npm run scan:tags [dir]
 * Pi:   ./scripts/oq3-tag-scan.sh
 * Prod: docker exec moneypenny-bot-1 node dist/tools/library-tag-scan.js /music
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as mm from "music-metadata";

const AUDIO_EXT = new Set([".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".wma", ".opus"]);
const MAX_DEPTH = 64;

export interface TagScanTally {
  total: number;
  parsed: number;
  failed: number;
  genre: number;
  bpm: number;
  key: number;
  mood: number;
  subgenre: number;
  genreHist: Map<string, number>;
}

export interface TagScanResult {
  dir: string;
  tally: TagScanTally;
  scanSeconds: number;
  verdict: string;
  report: string;
}

function nativeFrames(meta: mm.IAudioMetadata): { id: string; value: unknown }[] {
  const out: { id: string; value: unknown }[] = [];
  for (const frames of Object.values(meta.native ?? {})) {
    for (const f of frames) out.push({ id: String(f.id).toUpperCase(), value: f.value });
  }
  return out;
}

function hasFrame(frames: { id: string }[], ...ids: string[]): boolean {
  const want = ids.map((i) => i.toUpperCase());
  return frames.some((f) => want.some((w) => f.id === w || f.id.startsWith(w + ":")));
}

function emptyTally(): TagScanTally {
  return {
    total: 0,
    parsed: 0,
    failed: 0,
    genre: 0,
    bpm: 0,
    key: 0,
    mood: 0,
    subgenre: 0,
    genreHist: new Map(),
  };
}

async function scanFile(abs: string, t: TagScanTally): Promise<void> {
  t.total++;
  let meta: mm.IAudioMetadata;
  try {
    meta = await mm.parseFile(abs, { duration: false, skipCovers: true });
  } catch {
    t.failed++;
    return;
  }
  t.parsed++;
  const c = meta.common;
  const frames = nativeFrames(meta);

  if (c.genre && c.genre.length > 0) {
    t.genre++;
    for (const g of c.genre) t.genreHist.set(g, (t.genreHist.get(g) ?? 0) + 1);
  }
  if (c.bpm != null || hasFrame(frames, "TBPM", "BPM")) t.bpm++;
  if ((c as { key?: string }).key || hasFrame(frames, "TKEY", "INITIALKEY", "KEY")) t.key++;
  if ((c as { mood?: string }).mood || hasFrame(frames, "TMOO", "MOOD")) t.mood++;
  if (
    hasFrame(frames, "TXXX:SUBGENRE", "TXXX:STYLE", "SUBGENRE", "STYLE") ||
    (c as { subtitle?: unknown }).subtitle != null
  ) {
    t.subgenre++;
  }
}

async function walk(dir: string, t: TagScanTally, depth = 0): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await walk(full, t, depth + 1);
    else if (e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
      await scanFile(full, t);
    }
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? "  n/a" : `${((100 * n) / d).toFixed(1).padStart(5)}%`;
}

export function verdictForTally(t: TagScanTally): string {
  const denom = t.parsed;
  if (denom === 0) {
    return "no parsable audio at this path — point at the live MUSIC_DIR (the opi5 corpus).";
  }
  const keyCov = t.key / denom;
  const bpmCov = t.bpm / denom;
  const genCov = t.genre / denom;
  if (keyCov > 0.6 && bpmCov > 0.6) {
    return "key+BPM coverage is HIGH -> lean embedded + manual; defer the analyzer (OQ2).";
  }
  if (genCov > 0.7) {
    return "key/BPM sparse but genre rich -> keyfinder+aubio for key/BPM; mood/subgenre from genre+LLM/manual.";
  }
  return "coverage SPARSE -> keyfinder-cli + aubio earns its footprint (OQ2); analyzer is the canonical source.";
}

export function formatTagScanReport(dir: string, t: TagScanTally, scanSeconds: number): string {
  const denom = t.parsed;
  const lines = [
    `library-tag-scan: ${dir}`,
    "",
    `audio files found : ${t.total}`,
    `  parsed ok       : ${t.parsed}`,
    `  parse failures  : ${t.failed}`,
    `scan time         : ${scanSeconds.toFixed(1)}s`,
    "",
    "embedded tag coverage (% of parsed files):",
    `  genre   (TCON)  : ${String(t.genre).padStart(6)}   ${pct(t.genre, denom)}`,
    `  bpm     (TBPM)  : ${String(t.bpm).padStart(6)}   ${pct(t.bpm, denom)}`,
    `  key     (TKEY)  : ${String(t.key).padStart(6)}   ${pct(t.key, denom)}`,
    `  mood    (TMOO)  : ${String(t.mood).padStart(6)}   ${pct(t.mood, denom)}`,
    `  subgenre(TXXX)  : ${String(t.subgenre).padStart(6)}   ${pct(t.subgenre, denom)}`,
    "",
  ];

  const topGenres = [...t.genreHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (topGenres.length > 0) {
    lines.push("top genres:");
    for (const [g, n] of topGenres) lines.push(`  ${String(n).padStart(5)}  ${g}`);
    lines.push("");
  }

  lines.push(`verdict: ${verdictForTally(t)}`, "");
  return lines.join("\n");
}

/** Scan a directory and return structured results (testable). */
export async function scanMusicLibrary(dir: string): Promise<TagScanResult> {
  const resolved = path.resolve(dir);
  const tally = emptyTally();
  const started = Date.now();
  await walk(resolved, tally);
  const scanSeconds = (Date.now() - started) / 1000;
  const verdict = verdictForTally(tally);
  const report = formatTagScanReport(resolved, tally, scanSeconds);
  return { dir: resolved, tally, scanSeconds, verdict, report };
}

async function main(): Promise<void> {
  const dir = process.argv[2] || process.env.MUSIC_DIR || "/mnt/music";
  const result = await scanMusicLibrary(dir);
  process.stdout.write(result.report);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  main().catch((err) => {
    console.error("library-tag-scan failed:", err);
    process.exit(1);
  });
}