/**
 * library-tag-scan.ts — OQ3 measurement (radio.md §15.3 / §9.5).
 *
 * Counts how many tracks in a music library already carry the tags the radio
 * tag index wants (genre, BPM, musical key, mood, subgenre) so the analyzer
 * decision (OQ2) is made on data, not a guess:
 *   - high embedded coverage  -> lean embedded + manual, defer the analyzer
 *   - sparse coverage         -> keyfinder-cli + aubio earns its footprint
 *
 * Read-only. Never writes, never touches the running bot. Uses the same
 * `music-metadata` parser and the same audio-extension set as
 * bot/src/music/local.ts so the numbers reflect what `indexFile` could read.
 *
 * Run (from the bot package so music-metadata resolves):
 *   cd bot && npx tsx scripts/library-tag-scan.ts [dir]
 * Defaults to $MUSIC_DIR, then /mnt/music. On the opi5 the live corpus is the
 * one that matters — run it there.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as mm from "music-metadata";

// Mirrors LocalProvider's default supportedExtensions (local.ts).
const AUDIO_EXT = new Set([".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".wma", ".opus"]);
const MAX_DEPTH = 64; // matches LocalProvider.MAX_WALK_DEPTH

interface Tally {
  total: number;
  parsed: number;
  failed: number;
  genre: number;
  bpm: number;
  key: number;
  mood: number;
  subgenre: number; // any TXXX / custom vorbis field that looks like a sub-genre/style
  genreHist: Map<string, number>;
}

const t: Tally = {
  total: 0, parsed: 0, failed: 0,
  genre: 0, bpm: 0, key: 0, mood: 0, subgenre: 0,
  genreHist: new Map(),
};

/** Flatten music-metadata's native tag containers into {id, value} pairs. */
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

async function scanFile(abs: string): Promise<void> {
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

  // genre: common.genre (TCON / GENRE), array
  if (c.genre && c.genre.length > 0) {
    t.genre++;
    for (const g of c.genre) t.genreHist.set(g, (t.genreHist.get(g) ?? 0) + 1);
  }
  // bpm: common.bpm (TBPM / BPM) or native frame
  if (c.bpm != null || hasFrame(frames, "TBPM", "BPM")) t.bpm++;
  // musical key: common.key (TKEY / INITIALKEY / KEY) or native frame
  if ((c as { key?: string }).key || hasFrame(frames, "TKEY", "INITIALKEY", "KEY")) t.key++;
  // mood: common.mood (TMOO / MOOD) or native frame
  if ((c as { mood?: string }).mood || hasFrame(frames, "TMOO", "MOOD")) t.mood++;
  // subgenre/style: no standard frame — look for custom TXXX/vorbis fields
  if (hasFrame(frames, "TXXX:SUBGENRE", "TXXX:STYLE", "SUBGENRE", "STYLE") ||
      (c as { subtitle?: unknown }).subtitle != null) t.subgenre++;
}

async function walk(dir: string, depth = 0): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue; // match LocalProvider: don't follow symlinked dirs
    if (e.isDirectory()) {
      await walk(full, depth + 1);
    } else if (e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
      await scanFile(full);
    }
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? "  n/a" : `${((100 * n) / d).toFixed(1).padStart(5)}%`;
}

async function main(): Promise<void> {
  const dir = path.resolve(process.argv[2] || process.env.MUSIC_DIR || "/mnt/music");
  process.stdout.write(`library-tag-scan: ${dir}\n`);
  const started = Date.now();
  await walk(dir);
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  const denom = t.parsed; // coverage is over successfully-parsed files
  const lines = [
    "",
    `audio files found : ${t.total}`,
    `  parsed ok       : ${t.parsed}`,
    `  parse failures  : ${t.failed}`,
    `scan time         : ${secs}s`,
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

  // OQ3 verdict heuristic (radio.md §15.3): key+bpm drive the DJ tags; genre
  // drives mood/subgenre inference. Thresholds are advisory, not load-bearing.
  const keyCov = denom ? t.key / denom : 0;
  const bpmCov = denom ? t.bpm / denom : 0;
  const genCov = denom ? t.genre / denom : 0;
  let verdict: string;
  if (denom === 0) {
    verdict = "no parsable audio at this path — point at the live MUSIC_DIR (the opi5 corpus).";
  } else if (keyCov > 0.6 && bpmCov > 0.6) {
    verdict = "key+BPM coverage is HIGH -> lean embedded + manual; defer the analyzer (OQ2).";
  } else if (genCov > 0.7) {
    verdict = "key/BPM sparse but genre rich -> keyfinder+aubio for key/BPM; mood/subgenre from genre+LLM/manual.";
  } else {
    verdict = "coverage SPARSE -> keyfinder-cli + aubio earns its footprint (OQ2); analyzer is the canonical source.";
  }
  lines.push(`verdict: ${verdict}`, "");
  process.stdout.write(lines.join("\n"));
}

main().catch((err) => {
  console.error("library-tag-scan failed:", err);
  process.exit(1);
});
