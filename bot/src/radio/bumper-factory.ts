/**
 * RadioBumperFactory — the concrete R-R1 bumper source (docs/radio.md §6.1).
 * Implements the `BumperFactory` interface the RadioDirector consumes: given a
 * slot, try its sources in priority order and return the first that yields a
 * playable file. R-R1 covers the non-LLM sources:
 *   - prerecorded : a random asset from the bumper pool (§9.2)
 *   - stationId   : a canned station identifier, TTS'd + cached
 *   - timeCheck   : a spoken time check
 *   - nowPlaying  : "that was X, up next Y" from the queue
 * `doctrine`/`memory` (LLM + RAG, floored) arrive in R-R4 and resolve to null
 * here so they simply fall through.
 *
 * Never throws into the boundary path: any failure returns null and the
 * director advances the music (§14).
 */
import type { Logger } from "../logger.js";
import type { BuiltBumper, BumperFactory } from "./director.js";
import type { PrerecordedPool } from "./prerecorded.js";
import type { SpeechSink } from "./speech.js";
import type { BumperSource, RadioConfig, WheelSlot } from "./types.js";

export interface NowPlayingInfo {
  previous?: { name: string; artist?: string };
  next?: { name: string; artist?: string };
}

export interface RadioBumperFactoryDeps {
  getConfig: () => RadioConfig;
  prerecorded: PrerecordedPool;
  speech: SpeechSink;
  /** Snapshot of what just played / what's next, for the nowPlaying source. */
  getNowPlaying: () => NowPlayingInfo;
  /** Resolve a bumper-flagged library asset to a playable path (§9.2), or null.
   *  Tried before the prerecorded dir pool. Optional — absent falls back to the
   *  R-R1 dir scan. */
  getBumperAsset?: () => Promise<string | null>;
  /** Short station identifier spoken by stationId (e.g. the bot/station name). */
  stationName: string;
  logger: Logger;
  now?: () => number;
}

export class RadioBumperFactory implements BumperFactory {
  constructor(private deps: RadioBumperFactoryDeps) {}

  async build(slot: WheelSlot): Promise<BuiltBumper | null> {
    const cfg = this.deps.getConfig();
    const enabled = new Set(cfg.sources);
    const wanted = slot.sources && slot.sources.length > 0 ? slot.sources : cfg.sources;
    for (const src of wanted) {
      if (!enabled.has(src)) continue; // a slot can't use a globally-disabled source
      const built = await this.buildOne(src);
      if (built) return built;
    }
    return null;
  }

  private async buildOne(source: BumperSource): Promise<BuiltBumper | null> {
    try {
      switch (source) {
        case "prerecorded": {
          // Bumper-flagged library assets (§9.2) first, then the R-R1 dir pool.
          const flagged = this.deps.getBumperAsset ? await this.deps.getBumperAsset() : null;
          const path = flagged ?? this.deps.prerecorded.pick();
          return path ? { path, label: "prerecorded" } : null;
        }
        case "stationId":
          return this.speak(`This is ${this.deps.stationName}.`, "stationId");
        case "timeCheck":
          return this.speak(`The time is ${this.formatTime()}.`, "timeCheck");
        case "nowPlaying": {
          const text = this.nowPlayingText();
          return text ? this.speak(text, "nowPlaying") : null;
        }
        case "doctrine":
        case "memory":
          return null; // R-R4
        default:
          return null;
      }
    } catch (err) {
      this.deps.logger.warn({ err, source }, "radio: bumper source failed");
      return null;
    }
  }

  private async speak(text: string, label: string): Promise<BuiltBumper | null> {
    const path = await this.deps.speech.render(text, label);
    return path ? { path, label } : null;
  }

  private nowPlayingText(): string | null {
    const { previous, next } = this.deps.getNowPlaying();
    const prev = previous ? this.describe(previous) : null;
    const nxt = next ? this.describe(next) : null;
    if (prev && nxt) return `That was ${prev}. Up next, ${nxt}.`;
    if (prev) return `That was ${prev}.`;
    if (nxt) return `Up next, ${nxt}.`;
    return null;
  }

  private describe(t: { name: string; artist?: string }): string {
    return t.artist ? `${t.name} by ${t.artist}` : t.name;
  }

  private formatTime(): string {
    const d = new Date((this.deps.now ?? Date.now)());
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
  }
}
