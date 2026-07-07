/**
 * RadioAnalyzer — the local DSP tag sidecar (docs/radio.md §9.5, OQ2). Shells
 * out to keyfinder-cli (musical key) and aubio (BPM) and writes the results into
 * the TagStore as source="analyzer". Objective DJ tags only; mood/genre
 * (Essentia) is the deferred second pass (OQ2).
 *
 * Rules: off by default (`radio.analyzer.enabled`), never throws into a caller,
 * never blocks playback (batch is meant to run off-peak), and skips tracks that
 * already have analyzer key+BPM unless forced (cache by result, not re-run).
 *
 * ponytail: the CLI invocations and output shapes below are best-effort — the
 * real binaries aren't on the dev box, so the parsers are pure + unit-tested and
 * the exact flags/format need calibration on the opi5. `run` is injected so the
 * whole thing is testable without the tools installed.
 */
import { execFile } from "node:child_process";
import type { Logger } from "../logger.js";
import type { RadioConfig } from "./types.js";
import type { TagStore } from "./tag-store.js";

export interface RunResult {
  stdout: string;
  ok: boolean;
  /** false only when the binary itself is missing (ENOENT). */
  found: boolean;
}
export type CommandRunner = (cmd: string, args: string[]) => Promise<RunResult>;

const defaultRun: CommandRunner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const found = !(err && (err as NodeJS.ErrnoException).code === "ENOENT");
      resolve({ stdout: stdout ?? "", ok: !err, found });
    });
  });

export interface RadioAnalyzerDeps {
  tags: TagStore;
  getConfig: () => RadioConfig;
  logger: Logger;
  run?: CommandRunner;
  keyfinderBin?: string;
  aubioBin?: string;
}

export interface AnalyzeTrack {
  absPath: string;
  trackKey: string;
}

export class RadioAnalyzer {
  private run: CommandRunner;
  private keyfinderBin: string;
  private aubioBin: string;
  private availability: boolean | null = null;

  constructor(private deps: RadioAnalyzerDeps) {
    this.run = deps.run ?? defaultRun;
    this.keyfinderBin = deps.keyfinderBin ?? "keyfinder-cli";
    this.aubioBin = deps.aubioBin ?? "aubio";
  }

  /** True when both binaries are on PATH. Probed once, then cached. */
  async available(): Promise<boolean> {
    if (this.availability !== null) return this.availability;
    const [k, a] = await Promise.all([
      this.run(this.keyfinderBin, ["--help"]),
      this.run(this.aubioBin, ["--help"]),
    ]);
    this.availability = k.found && a.found;
    if (!this.availability) {
      this.deps.logger.info("radio analyzer: keyfinder-cli/aubio not found — key/BPM analysis disabled (install to enable)");
    }
    return this.availability;
  }

  /** Analyze one track, writing key/BPM to the overlay. Returns what it found,
   *  or null if it was skipped (already analyzed / unavailable / failed). */
  async analyzeTrack(t: AnalyzeTrack, opts: { force?: boolean } = {}): Promise<{ musicalKey?: string; bpm?: number } | null> {
    if (!(await this.available())) return null;
    if (!opts.force) {
      const cur = this.deps.tags.get(t.trackKey);
      if (cur?.musicalKey && cur.bpm) return null; // key+BPM already present
    }
    try {
      const [keyOut, bpmOut] = await Promise.all([
        this.run(this.keyfinderBin, [t.absPath]),
        this.run(this.aubioBin, ["tempo", t.absPath]),
      ]);
      const { musicalKey, keyScale } = keyOut.ok ? parseKey(keyOut.stdout) : {};
      const bpm = bpmOut.ok ? parseBpm(bpmOut.stdout) : undefined;
      if (musicalKey === undefined && bpm === undefined) return null;
      this.deps.tags.upsert(t.trackKey, { musicalKey, keyScale, bpm }, "analyzer");
      return { musicalKey, bpm };
    } catch (err) {
      this.deps.logger.warn({ err, path: t.absPath }, "radio analyzer: track failed — skipping");
      return null;
    }
  }

  /** Sequentially analyze a set of tracks (concurrency 1 — the RK3588 is busy).
   *  Never throws; returns a small tally. */
  async analyzeAll(tracks: AnalyzeTrack[], opts: { force?: boolean } = {}): Promise<{ analyzed: number; skipped: number }> {
    let analyzed = 0;
    let skipped = 0;
    if (!(await this.available())) return { analyzed: 0, skipped: tracks.length };
    for (const t of tracks) {
      const r = await this.analyzeTrack(t, opts);
      if (r) analyzed++;
      else skipped++;
    }
    this.deps.logger.info({ analyzed, skipped }, "radio analyzer: batch complete");
    return { analyzed, skipped };
  }
}

const clampBpm = (b: number): number | undefined => (b >= 40 && b <= 300 ? b : undefined);

/** Parse keyfinder-cli output. It prints the detected key (e.g. "Am", "F#",
 *  "8A"); we keep the raw string and derive major/minor when it's obvious. */
export function parseKey(out: string): { musicalKey?: string; keyScale?: string } {
  const key = out
    .trim()
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  if (!key) return {};
  let keyScale: string | undefined;
  if (/m(in(or)?)?$/i.test(key) || /^\d{1,2}A$/i.test(key)) keyScale = "minor";
  else if (/maj(or)?$/i.test(key) || /^\d{1,2}B$/i.test(key)) keyScale = "major";
  return { musicalKey: key, keyScale };
}

/** Parse a BPM from aubio output: a "128 bpm" label, a lone number, or a column
 *  of beat-onset times (seconds) → 60 / median inter-beat interval. */
export function parseBpm(out: string): number | undefined {
  const labeled = /(\d+(?:\.\d+)?)\s*bpm/i.exec(out);
  if (labeled) return clampBpm(Math.round(Number(labeled[1])));
  const nums = out
    .split(/\r?\n/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  if (nums.length === 1) return clampBpm(Math.round(nums[0]));
  if (nums.length >= 3) {
    const iv: number[] = [];
    for (let i = 1; i < nums.length; i++) iv.push(nums[i] - nums[i - 1]);
    iv.sort((a, b) => a - b);
    const med = iv[Math.floor(iv.length / 2)];
    if (med > 0) return clampBpm(Math.round(60 / med));
  }
  return undefined;
}
