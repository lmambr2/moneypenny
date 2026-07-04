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

/** Narrow retrieval seam (RetrievalStore.query) — floored server-side (§6.3). */
export interface BumperRetrieval {
  query(text: string, topK?: number, allowedClassifications?: string[]): Promise<{ text: string; source: string }[]>;
}

/** Narrow LLM seam (LlmModule.complete) — plain completion, tool_choice "none". */
export interface BumperLlm {
  complete(prompt: string, system?: string): Promise<string>;
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
  /** RAG substrate for the doctrine source (R-R4). Getters because both are
   *  hot-swappable at runtime; null → the source falls through (§14). */
  getRetrieval?: () => BumperRetrieval | null;
  getLlm?: () => BumperLlm | null;
  logger: Logger;
  now?: () => number;
}

/** ~150 spoken wpm (§6.2): seconds → word budget. */
const wordCap = (seconds: number): number => Math.max(20, Math.round(seconds * 2.5));

export class RadioBumperFactory implements BumperFactory {
  constructor(private deps: RadioBumperFactoryDeps) {}

  async build(slot: WheelSlot, floor: string[] = ["unclassified"]): Promise<BuiltBumper | null> {
    const cfg = this.deps.getConfig();
    const enabled = new Set(cfg.sources);
    const wanted = slot.sources && slot.sources.length > 0 ? slot.sources : cfg.sources;
    for (const src of wanted) {
      if (!enabled.has(src)) continue; // a slot can't use a globally-disabled source
      const built = await this.buildOne(src, floor, slot.topic);
      if (built) return built;
    }
    return null;
  }

  /** One-off operator liner (`!radio say`, §12): spoken as-is, length-capped,
   *  and rendered ephemeral — free operator text has no classification
   *  metadata, so it must never enter the persistent cache. */
  async say(text: string): Promise<BuiltBumper | null> {
    const clean = text.trim();
    if (!clean) return null;
    const cap = wordCap(this.deps.getConfig().maxBumperSeconds);
    const capped = clean.split(/\s+/).slice(0, cap).join(" ");
    const path = await this.deps.speech.render(capped, "say", { floor: ["unclassified", "operator"] });
    return path ? { path, label: "say" } : null;
  }

  private async buildOne(source: BumperSource, floor: string[], topic?: string): Promise<BuiltBumper | null> {
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
          return this.doctrineBumper(floor, topic);
        case "memory":
          return null; // OQ1: org MemPalace namespace — dormant until curated + opted in
        default:
          return null;
      }
    } catch (err) {
      this.deps.logger.warn({ err, source }, "radio: bumper source failed");
      return null;
    }
  }

  /** Doctrine → spoken bumper (§6.1/§6.2): floored retrieval → LLM rewrite
   *  (tool_choice "none" via LlmModule.complete) → capped script → TTS. Any
   *  missing piece returns null and the caller falls through (§14). */
  private async doctrineBumper(floor: string[], topicOverride?: string): Promise<BuiltBumper | null> {
    const retrieval = this.deps.getRetrieval?.() ?? null;
    const llm = this.deps.getLlm?.() ?? null;
    if (!retrieval || !llm) return null;

    const cfg = this.deps.getConfig();
    const profile = cfg.profiles[cfg.activeProfile];
    const topics = topicOverride ? [topicOverride] : profile?.bumper?.topics ?? [];
    if (topics.length === 0) return null; // nothing curated to talk about
    const topic = topics[Math.floor(Math.random() * topics.length)];

    // Floor applied to the retrieval filter BEFORE text reaches the model (§6.3).
    const chunks = await retrieval.query(topic, 3, floor);
    const material = chunks[0]?.text?.trim();
    if (!material) return null;

    const cap = wordCap(cfg.maxBumperSeconds);
    const tone = profile?.bumper?.tone ? ` Tone: ${profile.bumper.tone}.` : "";
    const script = (
      await llm.complete(
        `Rewrite the following as a spoken radio bumper: under ${cap} words, one breath, plain speech, no markdown, no lists. Invent nothing — only rephrase what is given.${tone}\n\n${material}`,
        "You are a radio announcer. Reply with only the spoken line itself.",
      )
    ).trim();
    if (!script) return null;

    const capped = script.split(/\s+/).slice(0, cap).join(" ");
    const path = await this.deps.speech.render(capped, "doctrine", { floor });
    return path ? { path, label: "doctrine" } : null;
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
