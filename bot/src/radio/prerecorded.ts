/**
 * PrerecordedPool — the R-R1 `prerecorded` bumper source (docs/radio.md §6.1/§9.2).
 * A dedicated directory of ready-to-play bumper assets (jingles/IDs/sweepers):
 * highest reliability, zero gen latency, zero injection risk — the default and
 * fallback source.
 *
 * R-R1 keeps it simple: scan a directory for audio files and pick one at
 * random. R-R2 replaces the directory convention with the tag overlay's
 * `bumper`-flagged assets (+ bumperKind/opsScope filtering).
 */
import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import type { Logger } from "../logger.js";

const AUDIO_EXT = new Set([".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".opus"]);
const RESCAN_MS = 60_000;

export interface PrerecordedPoolDeps {
  /** Absolute path to the bumper assets directory (may not exist yet). */
  dir: string;
  logger: Logger;
  now?: () => number;
  /** Injectable RNG for deterministic tests. */
  random?: () => number;
}

export class PrerecordedPool {
  private files: string[] = [];
  private scannedAt = 0;

  constructor(private deps: PrerecordedPoolDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Refresh the file list at most once per RESCAN_MS. Cheap, non-blocking. */
  private ensureScanned(): void {
    if (this.files.length > 0 && this.now() - this.scannedAt < RESCAN_MS) return;
    this.scannedAt = this.now();
    try {
      this.files = readdirSync(this.deps.dir)
        .filter((f) => AUDIO_EXT.has(extname(f).toLowerCase()))
        .map((f) => join(this.deps.dir, f));
    } catch {
      // Missing/unreadable dir → empty pool (the factory falls through to the
      // next source). Never throws into the boundary path.
      this.files = [];
    }
  }

  /** True when at least one prerecorded asset is available. */
  get available(): boolean {
    this.ensureScanned();
    return this.files.length > 0;
  }

  /** Pick a random prerecorded bumper path, or null when the pool is empty. */
  pick(): string | null {
    this.ensureScanned();
    if (this.files.length === 0) return null;
    const rng = this.deps.random ?? Math.random;
    return this.files[Math.floor(rng() * this.files.length)];
  }
}
