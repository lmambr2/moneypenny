/**
 * ACE-Step generation → local library (docs/ace-step.md A2).
 * Writes under MUSIC_DIR/<outputDir>/, re-indexes LocalProvider, returns a Song.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { BotConfig } from "../data/config.js";
import type { Logger } from "../logger.js";
import type { Song } from "./provider.js";
import type { LocalProvider } from "./local.js";
import { AceStepClient } from "./ace-step-client.js";
import type { TagStore } from "../radio/tag-store.js";

const MAX_CONCURRENT = 1;
const RATE_WINDOW_MS = 60 * 60_000;
const RATE_MAX = 3;

export interface GenerateProviderDeps {
  getConfig: () => BotConfig;
  getClient: () => AceStepClient | null;
  localProvider: LocalProvider;
  tagStore?: TagStore | null;
  logger: Logger;
  defaultDurationSec?: number;
  now?: () => number;
  /** When set, successful gens are started on the player (A2 play path). */
  playSong?: (song: Song) => Promise<string>;
}

export type GenerateResult =
  | { ok: true; song: Song; relPath: string; jobId: string }
  | { ok: false; error: string };

export class GenerateProvider {
  private inFlight = 0;
  private rateLog = new Map<string, number[]>();

  constructor(private deps: GenerateProviderDeps) {}

  /** True when enabled + URL configured (does not ping the sidecar). */
  isConfigured(): boolean {
    const c = this.deps.getConfig();
    return !!c.aceStepEnabled && !!c.aceStepUrl?.trim();
  }

  /** True while a user !generate or radio auto-fill job is running. */
  isBusy(): boolean {
    return this.inFlight > 0;
  }

  async handleGenerate(args: string, invokerKey = "anon"): Promise<string> {
    const prompt = args?.trim();
    if (!prompt) {
      return "Usage: !generate <prompt> — e.g. !generate late night focus, 110 bpm, no vocals";
    }
    if (!this.isConfigured()) {
      return "Music generation is off. An admin can enable ACE-Step in config (aceStepEnabled + aceStepUrl).";
    }
    const client = this.deps.getClient();
    if (!client) {
      return "ACE-Step client not available — check aceStepUrl.";
    }

    const rate = this.checkRate(invokerKey);
    if (!rate.ok) {
      return `Generation rate limit — try again in ~${rate.waitMin} min (max ${RATE_MAX}/hour).`;
    }
    if (this.inFlight >= MAX_CONCURRENT) {
      return "A generation job is already running — try again when it finishes.";
    }

    this.recordRate(invokerKey);
    try {
      // trackInFlight default true inside generateAndIngest
      const result = await this.generateAndIngest(prompt, client);
      if (!result.ok) return `Generation failed: ${result.error}`;
      if (this.deps.playSong) {
        try {
          const playMsg = await this.deps.playSong(result.song);
          return `Generated · ${playMsg}`;
        } catch (err) {
          this.deps.logger.warn({ err }, "ACE-Step play after gen failed");
          return `Generated ${result.song.name} (${result.relPath}) but playback failed — try !play ${result.relPath}`;
        }
      }
      return `Generated: ${result.song.name} (${result.relPath})`;
    } catch (err) {
      this.deps.logger.warn({ err, prompt: prompt.slice(0, 80) }, "ACE-Step generate failed");
      return `Generation failed: ${err instanceof Error ? err.message : "unknown error"}`;
    }
  }

  /**
   * Core path for !generate and (later) radio auto-fill.
   * Does not enqueue playback — caller decides.
   */
  /**
   * Core path for !generate and radio auto-fill.
   * @param opts.trackInFlight — count against concurrent slot (default true for auto-fill).
   */
  async generateAndIngest(
    prompt: string,
    client?: AceStepClient | null,
    opts?: { trackInFlight?: boolean },
  ): Promise<GenerateResult> {
    const trackInFlight = opts?.trackInFlight !== false;
    if (trackInFlight) {
      if (this.inFlight >= MAX_CONCURRENT) {
        return { ok: false, error: "generation already in progress" };
      }
      this.inFlight += 1;
    }
    try {
      return await this.generateAndIngestInner(prompt, client);
    } finally {
      if (trackInFlight) this.inFlight = Math.max(0, this.inFlight - 1);
    }
  }

  private async generateAndIngestInner(
    prompt: string,
    client?: AceStepClient | null,
  ): Promise<GenerateResult> {
    const c = client ?? this.deps.getClient();
    if (!c) return { ok: false, error: "no client" };
    const cfg = this.deps.getConfig();
    const durationSec = this.deps.defaultDurationSec ?? 120;
    const maxWaitMs = cfg.aceStepTimeoutMs || 300_000;

    const healthy = await c.isAvailable();
    if (!healthy) return { ok: false, error: "ACE-Step sidecar unreachable" };

    const started = await c.generate({
      prompt: prompt.trim(),
      durationSec,
      tags: ["ace-step", "generated"],
    });
    const job = await c.waitForJob(started.id, { maxWaitMs, pollMs: 2_000 });
    if (job.status === "error") {
      return { ok: false, error: job.error || "job error" };
    }
    if (job.status !== "done") {
      return { ok: false, error: job.error || `unexpected status ${job.status}` };
    }

    const musicDir = path.resolve(this.deps.localProvider.getMusicDir());
    const outSub = (cfg.aceStepOutputDir || "generated/ace-step").replace(/^\/+/, "");
    const outDir = path.resolve(musicDir, outSub);
    await fs.mkdir(outDir, { recursive: true });

    let absPath: string | null = null;

    if (job.path) {
      absPath = await this.resolveSharedPath(job.path, musicDir, outDir);
    }

    if (!absPath) {
      const buf = await c.downloadAudio(job.id);
      const ext = sniffExt(buf);
      const base = slugify(prompt).slice(0, 48) || "track";
      const stamp = new Date((this.deps.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-");
      absPath = path.join(outDir, `${stamp}-${base}${ext}`);
      await fs.writeFile(absPath, buf);
    }

    // Containment: must live under musicDir
    const realFile = await fs.realpath(absPath);
    const realMusic = await fs.realpath(musicDir);
    if (realFile !== realMusic && !realFile.startsWith(realMusic + path.sep)) {
      try {
        await fs.unlink(realFile);
      } catch {
        /* ignore */
      }
      return { ok: false, error: "refusing path outside music library" };
    }

    await this.deps.localProvider.refresh();
    const rel = path.relative(realMusic, realFile);
    let song: Song | null = null;
    const resolved = await this.deps.localProvider.resolve(rel);
    if (resolved?.type === "song") song = resolved.item as Song;
    if (!song) {
      const byBase = await this.deps.localProvider.resolve(path.basename(realFile));
      if (byBase?.type === "song") song = byBase.item as Song;
    }
    if (!song) {
      // Metadata parse can fail on odd codecs — still report path.
      return {
        ok: false,
        error: `file written (${rel}) but not indexed — try !refresh or reindex music`,
      };
    }

    try {
      this.deps.tagStore?.upsert(song.id, { genre: "generated", mood: "ace-step" }, "manual");
    } catch {
      /* tags optional */
    }

    return { ok: true, song, relPath: rel, jobId: job.id };
  }

  private async resolveSharedPath(
    jobPath: string,
    musicDir: string,
    outDir: string,
  ): Promise<string | null> {
    const candidates = [
      path.isAbsolute(jobPath) ? jobPath : path.resolve(musicDir, jobPath),
      path.resolve(outDir, path.basename(jobPath)),
    ];
    for (const cand of candidates) {
      try {
        const real = await fs.realpath(cand);
        const realMusic = await fs.realpath(musicDir);
        if (real === realMusic || real.startsWith(realMusic + path.sep)) {
          await fs.access(real);
          return real;
        }
      } catch {
        /* try next */
      }
    }
    return null;
  }

  private checkRate(key: string): { ok: true } | { ok: false; waitMin: number } {
    const now = (this.deps.now ?? Date.now)();
    const arr = (this.rateLog.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    this.rateLog.set(key, arr);
    if (arr.length >= RATE_MAX) {
      const oldest = Math.min(...arr);
      const waitMin = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - oldest)) / 60_000));
      return { ok: false, waitMin };
    }
    return { ok: true };
  }

  private recordRate(key: string): void {
    const now = (this.deps.now ?? Date.now)();
    const arr = (this.rateLog.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    arr.push(now);
    this.rateLog.set(key, arr);
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function sniffExt(buf: Buffer): string {
  if (buf.length >= 4 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    return ".wav";
  }
  if (buf.length >= 3 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return ".mp3";
  if (buf.length >= 3 && buf.toString("ascii", 0, 3) === "ID3") return ".mp3";
  return ".mp3";
}
