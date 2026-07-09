/**
 * RadioBumperFactory — bumper sources for the RadioDirector (docs/radio.md §6.1).
 *
 * Source selection (scheduled *and* forced `!radio bumper`):
 *   - **Round-robin diversity:** a source that already won/tried this cycle is
 *     deferred until every other enabled source has been tried, then the cycle resets.
 *   - Within the "fresh" set, order is **weighted random** (equal by default;
 *     optional `profile.bumper.sourceWeights`).
 *   - `!radio bumper <topic>` still targets doctrine only.
 *
 * Sources:
 *   - prerecorded : random asset from bumper-flagged library or `data/bumpers/`
 *   - stationId   : canned station ID (TTS + cache)
 *   - timeCheck   : spoken clock
 *   - nowPlaying  : previous / next from the queue
 *   - doctrine    : floored RAG + LLM rewrite
 *   - memory      : org MemPalace KG when opt-in
 *
 * Never throws into the boundary path: any failure returns null and music advances.
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
  query(
    text: string,
    topK?: number,
    allowedClassifications?: string[],
  ): Promise<{ text: string; source: string }[]>;
}

/** Narrow LLM seam (LlmModule.complete) — plain completion, tool_choice "none". */
export interface BumperLlm {
  complete(prompt: string, system?: string): Promise<string>;
}

/**
 * Org knowledge graph only (MemPalace `org_kg` / diaries via kgSearch).
 * Must never expose per-user `!remember` rooms.
 */
export interface BumperOrgMemory {
  searchOrg(query: string, limit?: number): Promise<Array<{ fact: string }>>;
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
  /** Org MemPalace KG for the memory bumper (OQ1 opt-in). */
  getOrgMemory?: () => BumperOrgMemory | null;
  logger: Logger;
  now?: () => number;
  /** Injectable RNG for tests (default Math.random). */
  random?: () => number;
}

/** ~150 spoken wpm (§6.2): seconds → word budget. */
const wordCap = (seconds: number): number => Math.max(20, Math.round(seconds * 2.5));

const DEFAULT_STATION_ID_TEMPLATES = [
  "This is {name}.",
  "You're listening to {name}.",
  "Stay tuned on {name}.",
] as const;

/**
 * Resolve spoken station-ID lines from config + station name.
 * Empty `stationIdLines` → built-in defaults. Supports `{name}` / `{station}`.
 */
export function resolveStationIdLines(stationName: string, configured?: string[] | null): string[] {
  const name = (stationName || "Moneypenny").trim() || "Moneypenny";
  const expand = (s: string) =>
    s
      .replace(/\{name\}/gi, name)
      .replace(/\{station\}/gi, name)
      .trim();
  const custom = (configured ?? []).map(expand).filter(Boolean);
  if (custom.length > 0) return custom;
  return DEFAULT_STATION_ID_TEMPLATES.map(expand);
}

/** Join station-ID phrases into one spoken package (ensure terminal punctuation). */
export function joinSpokenLines(lines: string[]): string {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[.!?…]"?$/.test(l) ? l : `${l}.`))
    .join(" ");
}

export interface TimeZoneSpec {
  /** IANA zone id, or null for host local. */
  zone: string | null;
  /** Spoken place name (e.g. "New York"). Empty for single local check. */
  label: string;
}

/**
 * Common non-IANA city / US shortcuts → real zones.
 * (e.g. America/Seattle is invalid — Pacific is America/Los_Angeles.)
 */
const ZONE_ALIASES: Record<string, string> = {
  "america/seattle": "America/Los_Angeles",
  "america/portland": "America/Los_Angeles",
  "us/pacific": "America/Los_Angeles",
  "us/eastern": "America/New_York",
  "us/mountain": "America/Denver",
  "us/central": "America/Chicago",
  pacific: "America/Los_Angeles",
  eastern: "America/New_York",
  mountain: "America/Denver",
  central: "America/Chicago",
  seattle: "America/Los_Angeles",
  denver: "America/Denver",
  "new york": "America/New_York",
  new_york: "America/New_York",
  london: "Europe/London",
  utc: "UTC",
};

function tryResolveZone(raw: string): { ok: true; zone: string | null } | { ok: false } {
  const z = raw.trim();
  if (!z) return { ok: false };
  if (z.toLowerCase() === "local" || z === "host") return { ok: true, zone: null };
  const aliased = ZONE_ALIASES[z.toLowerCase()] ?? z;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: aliased });
    return { ok: true, zone: aliased };
  } catch {
    return { ok: false };
  }
}

/** Parse config lines: `America/New_York` or `Europe/London|London`. Empty → local only. */
export function parseTimeCheckTimezones(configured?: string[] | null): TimeZoneSpec[] {
  const raw = (configured ?? []).map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) return [{ zone: null, label: "" }];
  const out: TimeZoneSpec[] = [];
  for (const line of raw.slice(0, 8)) {
    const pipe = line.indexOf("|");
    const zoneRaw = (pipe >= 0 ? line.slice(0, pipe) : line).trim();
    let label = (pipe >= 0 ? line.slice(pipe + 1) : "").trim();
    if (!zoneRaw) continue;
    const resolved = tryResolveZone(zoneRaw);
    if (!resolved.ok) {
      // Keep going — invalid zones used to be silently dropped (e.g. America/Seattle).
      continue;
    }
    const isLocal = resolved.zone == null;
    if (!label && !isLocal && resolved.zone) {
      const tail = resolved.zone.includes("/")
        ? resolved.zone.slice(resolved.zone.lastIndexOf("/") + 1)
        : resolved.zone;
      label = tail.replace(/_/g, " ");
    }
    out.push({ zone: resolved.zone, label });
  }
  return out.length > 0 ? out : [{ zone: null, label: "" }];
}

/**
 * Like parseTimeCheckTimezones but reports which raw lines were dropped so Settings/logs
 * can surface typos (America/Seattle, etc.).
 */
export function parseTimeCheckTimezonesDetailed(configured?: string[] | null): {
  zones: TimeZoneSpec[];
  skipped: string[];
} {
  const raw = (configured ?? []).map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0) return { zones: [{ zone: null, label: "" }], skipped: [] };
  const zones: TimeZoneSpec[] = [];
  const skipped: string[] = [];
  for (const line of raw.slice(0, 8)) {
    const pipe = line.indexOf("|");
    const zoneRaw = (pipe >= 0 ? line.slice(0, pipe) : line).trim();
    let label = (pipe >= 0 ? line.slice(pipe + 1) : "").trim();
    if (!zoneRaw) {
      skipped.push(line);
      continue;
    }
    const resolved = tryResolveZone(zoneRaw);
    if (!resolved.ok) {
      skipped.push(line);
      continue;
    }
    const isLocal = resolved.zone == null;
    if (!label && !isLocal && resolved.zone) {
      const tail = resolved.zone.includes("/")
        ? resolved.zone.slice(resolved.zone.lastIndexOf("/") + 1)
        : resolved.zone;
      label = tail.replace(/_/g, " ");
    }
    zones.push({ zone: resolved.zone, label });
  }
  return {
    zones: zones.length > 0 ? zones : [{ zone: null, label: "" }],
    skipped,
  };
}

/** 12-hour spoken clock for a zone (or host local when zone is null). */
export function formatClockInZone(ms: number, timeZone?: string | null): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      ...(timeZone ? { timeZone } : {}),
    }).formatToParts(new Date(ms));
    const hour = parts.find((p) => p.type === "hour")?.value ?? "12";
    const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
    const dayPeriod = (parts.find((p) => p.type === "dayPeriod")?.value ?? "AM").toUpperCase();
    return `${hour}:${minute.padStart(2, "0")} ${dayPeriod}`;
  } catch {
    // Fallback local formatting
    const d = new Date(ms);
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
  }
}

/**
 * Full time-check sentence. One zone: "The time is 2:05 PM."
 * Several: "The time is 2:05 PM in New York, and 7:05 PM in London."
 */
export function buildTimeCheckSpeech(ms: number, zones: TimeZoneSpec[]): string {
  const specs = zones.length > 0 ? zones : [{ zone: null, label: "" }];
  if (specs.length === 1) {
    const z = specs[0]!;
    const clock = formatClockInZone(ms, z.zone);
    if (z.label) return `The time is ${clock} in ${z.label}.`;
    return `The time is ${clock}.`;
  }
  const bits = specs.map((z) => {
    const clock = formatClockInZone(ms, z.zone);
    return z.label ? `${clock} in ${z.label}` : clock;
  });
  if (bits.length === 2) return `The time is ${bits[0]}, and ${bits[1]}.`;
  const last = bits[bits.length - 1];
  return `The time is ${bits.slice(0, -1).join(", ")}, and ${last}.`;
}

/**
 * Weighted random order of bumper sources (without replacement).
 * Missing weights default to 1; weight ≤ 0 drops the source from the draw.
 * With a constant rng near 0 and equal weights, order matches `candidates` input order.
 */
export function orderBumperSources(
  candidates: BumperSource[],
  weights: Partial<Record<BumperSource, number>> | undefined,
  rng: () => number = Math.random,
): BumperSource[] {
  const bag = candidates
    .map((src) => {
      const raw = weights?.[src];
      const w = raw == null ? 1 : Number(raw);
      return { src, w: Number.isFinite(w) && w > 0 ? w : 0 };
    })
    .filter((x) => x.w > 0);
  if (bag.length === 0) return [];

  const remaining = bag.slice();
  const out: BumperSource[] = [];
  while (remaining.length > 0) {
    const total = remaining.reduce((s, x) => s + x.w, 0);
    let r = rng() * total;
    let idx = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) {
      r -= remaining[i]!.w;
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    out.push(remaining[idx]!.src);
    remaining.splice(idx, 1);
  }
  return out;
}

/**
 * Split candidates into "not yet tried this cycle" (try first) and already-tried
 * (fallback only if every fresh source fails). When the cycle is full, reset.
 */
export function partitionSourcesForCycle(
  candidates: BumperSource[],
  usedThisCycle: ReadonlySet<BumperSource>,
): { fresh: BumperSource[]; fallback: BumperSource[]; resetCycle: boolean } {
  if (candidates.length === 0) return { fresh: [], fallback: [], resetCycle: false };
  const fresh = candidates.filter((s) => !usedThisCycle.has(s));
  if (fresh.length === 0) {
    // Full cycle complete — everyone was tried; start over with all candidates.
    return { fresh: candidates.slice(), fallback: [], resetCycle: true };
  }
  const fallback = candidates.filter((s) => usedThisCycle.has(s));
  return { fresh, fallback, resetCycle: false };
}

export class RadioBumperFactory implements BumperFactory {
  /** Sources already tried (success or fail) in the current diversity cycle. */
  private usedThisCycle = new Set<BumperSource>();

  constructor(private deps: RadioBumperFactoryDeps) {}

  async build(slot: WheelSlot, floor: string[] = ["unclassified"]): Promise<BuiltBumper | null> {
    const cfg = this.deps.getConfig();
    const enabled = new Set(cfg.sources);
    const wanted = (slot.sources && slot.sources.length > 0 ? slot.sources : cfg.sources).filter(
      (s) => enabled.has(s),
    );

    // Explicit topic (e.g. !radio bumper mining) → doctrine only (does not burn cycle).
    if (slot.topic?.trim()) {
      const built = await this.buildOne("doctrine", floor, slot.topic.trim());
      if (built) {
        this.deps.logger.info(
          { source: "doctrine", topic: slot.topic },
          "radio: bumper source chosen",
        );
        return built;
      }
      return null;
    }

    if (wanted.length === 0) return null;

    // Drop cycle entries that are no longer in the candidate list (sources toggled off).
    for (const s of [...this.usedThisCycle]) {
      if (!wanted.includes(s)) this.usedThisCycle.delete(s);
    }

    const profile = cfg.profiles[cfg.activeProfile];
    const weights = profile?.bumper?.sourceWeights;
    const rng = this.deps.random ?? Math.random;
    const part = partitionSourcesForCycle(wanted, this.usedThisCycle);
    if (part.resetCycle) this.usedThisCycle.clear();

    const order = [
      ...orderBumperSources(part.fresh, weights, rng),
      ...orderBumperSources(part.fallback, weights, rng),
    ];

    for (const src of order) {
      const built = await this.buildOne(src, floor, slot.topic);
      // Mark tried on success or fail so a dead source cannot monopolize the cycle.
      this.usedThisCycle.add(src);
      if (built) {
        // Cycle complete: clear everyone, then re-block the winner so the next
        // break must try other sources first before this one can win again.
        if (wanted.every((s) => this.usedThisCycle.has(s))) {
          this.usedThisCycle.clear();
          this.usedThisCycle.add(src);
        }
        this.deps.logger.info(
          {
            source: src,
            label: built.label,
            order,
            cycleUsed: [...this.usedThisCycle],
          },
          "radio: bumper source chosen",
        );
        return built;
      }
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
    const path = await this.deps.speech.render(capped, "say", {
      floor: ["unclassified", "operator"],
    });
    return path ? { path, label: "say" } : null;
  }

  /**
   * Pre-render common liners into the TTS bumper cache so live slots don't wait
   * on synthesis. Safe / fail-open: never throws; returns a tally.
   *
   * - stationId + canned welcomes
   * - timeCheck phrases for the next N hours (top of hour + :30)
   * - optional free-text lines (operator pack)
   * - optional doctrine (LLM rewrite + TTS per profile topic, unclassified floor)
   */
  async prewarm(
    opts: { includeDoctrine?: boolean; hoursAhead?: number; lines?: string[] } = {},
  ): Promise<{
    rendered: number;
    failed: number;
    details: string[];
  }> {
    const details: string[] = [];
    let rendered = 0;
    let failed = 0;
    const render = async (text: string, source: string) => {
      try {
        const path = await this.deps.speech.render(text, source, { floor: ["unclassified"] });
        if (path) {
          rendered++;
          details.push(`${source}: ok`);
        } else {
          failed++;
          details.push(`${source}: tts-null`);
        }
      } catch {
        failed++;
        details.push(`${source}: error`);
      }
    };

    const cfg = this.deps.getConfig();

    // Station ID liners (config `stationIdLines`, or built-in defaults).
    for (const line of resolveStationIdLines(this.deps.stationName, cfg.stationIdLines)) {
      await render(line, "stationId");
    }

    // Time checks for the next hoursAhead hours (default 12) at :00 and :30.
    const { zones, skipped: skippedZones } = parseTimeCheckTimezonesDetailed(
      cfg.timeCheckTimezones,
    );
    if (skippedZones.length > 0) {
      this.deps.logger.warn(
        { skipped: skippedZones },
        "radio: invalid timeCheckTimezones entries skipped during prewarm",
      );
    }
    const hours = Math.max(1, Math.min(opts.hoursAhead ?? 12, 24));
    const base = (this.deps.now ?? Date.now)();
    const seen = new Set<string>();
    for (let h = 0; h < hours; h++) {
      for (const min of [0, 30]) {
        const t = new Date(base);
        t.setMinutes(min, 0, 0);
        t.setHours(t.getHours() + h);
        const speech = buildTimeCheckSpeech(t.getTime(), zones);
        if (seen.has(speech)) continue;
        seen.add(speech);
        await render(speech, "timeCheck");
      }
    }

    // Operator-supplied pack
    for (const line of opts.lines ?? []) {
      const clean = line.trim();
      if (!clean) continue;
      const cap = wordCap(cfg.maxBumperSeconds);
      const capped = clean.split(/\s+/).slice(0, cap).join(" ");
      await render(capped, "prewarm");
    }

    // Doctrine: one TTS-ready bumper per profile topic (needs LLM + RAG).
    if (opts.includeDoctrine) {
      const profile = cfg.profiles[cfg.activeProfile];
      const topics = profile?.bumper?.topics ?? [];
      for (const topic of topics.slice(0, 8)) {
        try {
          const built = await this.doctrineBumper(["unclassified"], topic);
          if (built) {
            rendered++;
            details.push(`doctrine:${topic}: ok`);
          } else {
            failed++;
            details.push(`doctrine:${topic}: skip`);
          }
        } catch {
          failed++;
          details.push(`doctrine:${topic}: error`);
        }
      }
    }

    this.deps.logger.info({ rendered, failed }, "radio: bumper prewarm complete");
    return { rendered, failed, details };
  }

  private async buildOne(
    source: BumperSource,
    floor: string[],
    topic?: string,
  ): Promise<BuiltBumper | null> {
    try {
      switch (source) {
        case "prerecorded": {
          // Bumper-flagged library assets (§9.2) first, then the R-R1 dir pool.
          const flagged = this.deps.getBumperAsset ? await this.deps.getBumperAsset() : null;
          const path = flagged ?? this.deps.prerecorded.pick();
          return path ? { path, label: "prerecorded" } : null;
        }
        case "stationId": {
          // All configured liners play as one package (order preserved). Previously
          // only a single random line fired, so 2nd/3rd liners appeared "skipped".
          const lines = resolveStationIdLines(
            this.deps.stationName,
            this.deps.getConfig().stationIdLines,
          );
          if (lines.length === 0) return null;
          const text = joinSpokenLines(lines);
          return this.speak(text, "stationId");
        }
        case "timeCheck": {
          const { zones, skipped } = parseTimeCheckTimezonesDetailed(
            this.deps.getConfig().timeCheckTimezones,
          );
          if (skipped.length > 0) {
            this.deps.logger.warn(
              { skipped },
              "radio: invalid timeCheckTimezones entries skipped (use IANA ids, e.g. America/Los_Angeles not America/Seattle)",
            );
          }
          const speech = buildTimeCheckSpeech((this.deps.now ?? Date.now)(), zones);
          return this.speak(speech, "timeCheck");
        }
        case "nowPlaying": {
          const text = this.nowPlayingText();
          return text ? this.speak(text, "nowPlaying") : null;
        }
        case "doctrine":
          return this.doctrineBumper(floor, topic);
        case "memory":
          return this.memoryBumper(topic);
        default:
          return null;
      }
    } catch (err) {
      this.deps.logger.warn({ err, source }, "radio: bumper source failed");
      return null;
    }
  }

  /**
   * Org MemPalace → spoken bumper (OQ1). Requires `memoryBroadcastOptIn` and
   * `memory` in `radio.sources`. Uses kgSearch only (never per-user rooms).
   */
  private async memoryBumper(topicOverride?: string): Promise<BuiltBumper | null> {
    const cfg = this.deps.getConfig();
    if (!cfg.memoryBroadcastOptIn) return null;

    const orgMem = this.deps.getOrgMemory?.() ?? null;
    const llm = this.deps.getLlm?.() ?? null;
    if (!orgMem || !llm) return null;

    const profile = cfg.profiles[cfg.activeProfile];
    const topics = topicOverride
      ? [topicOverride]
      : profile?.bumper?.topics?.length
        ? profile.bumper.topics
        : ["organization roles operations"];
    const topic = topics[Math.floor(Math.random() * topics.length)];

    const hits = await orgMem.searchOrg(topic, 5);
    const material = hits.map((h) => h.fact.trim()).filter(Boolean)[0];
    if (!material) return null;

    const cap = wordCap(cfg.maxBumperSeconds);
    const tone = profile?.bumper?.tone ? ` Tone: ${profile.bumper.tone}.` : "";
    const script = (
      await llm.complete(
        `Rewrite the following as a short spoken radio station note: under ${cap} words, one breath, plain speech, no markdown, no lists, no private names unless present. Invent nothing — only rephrase what is given.${tone}\n\n${material}`,
        "You are a radio announcer. Reply with only the spoken line itself. Never invent personal facts.",
      )
    ).trim();
    if (!script) return null;

    const capped = script.split(/\s+/).slice(0, cap).join(" ");
    // Floor unclassified only — org memory is not doctrine classification tiers.
    const path = await this.deps.speech.render(capped, "memory", {
      floor: ["unclassified"],
    });
    return path ? { path, label: "memory" } : null;
  }

  /** Doctrine → spoken bumper (§6.1/§6.2): floored retrieval → LLM rewrite
   *  (tool_choice "none" via LlmModule.complete) → capped script → TTS. Any
   *  missing piece returns null and the caller falls through (§14). */
  private async doctrineBumper(
    floor: string[],
    topicOverride?: string,
  ): Promise<BuiltBumper | null> {
    const retrieval = this.deps.getRetrieval?.() ?? null;
    const llm = this.deps.getLlm?.() ?? null;
    if (!retrieval || !llm) return null;

    const cfg = this.deps.getConfig();
    const profile = cfg.profiles[cfg.activeProfile];
    const topics = topicOverride ? [topicOverride] : (profile?.bumper?.topics ?? []);
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

  /** Same spoken time format as live timeCheck, for an arbitrary timestamp (host local). */
  formatTimeAt(ms: number): string {
    return formatClockInZone(ms, null);
  }
}
