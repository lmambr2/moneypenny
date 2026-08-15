/**
 * Radio / autonomous-DJ configuration (docs/radio.md §11). Mirrors the voice/llm
 * blocks: a `RadioConfig` type + a `defaultRadioConfig()` factory composed into
 * BotConfig. Off by default — `enabled: false` must be byte-identical to today.
 *
 * R-R1 consumes only the scheduling/gating fields (everyNSongs, deadAir, limits,
 * quietHours, sources). The selection/analysis/rating fields are declared for
 * forward-compat with R-R2..R-R6 but are not read yet.
 */

/** Bumper content sources (§6.1). R-R1 ships the non-LLM ones. */
export type BumperSource =
  | "prerecorded"
  | "stationId"
  | "timeCheck"
  | "nowPlaying"
  | "doctrine" // R-R4 (LLM + RAG)
  | "memory"; // R-R4 (org-scoped MemPalace)

/** A slot in the rotation wheel (§7). */
export type SlotKind = "song" | "bumper" | "stationId";

export interface WheelSlot {
  slot: SlotKind;
  /** For bumper slots: candidate sources, highest-priority first. */
  sources?: BumperSource[];
  /** Optional topic override for generated sources (`!radio bumper <topic>`). */
  topic?: string;
}

/** Declarative rotation wheel (§7). `clock?` in RadioConfig; optional — the
 *  `everyNSongs` shortcut synthesizes an equivalent wheel when this is absent. */
export interface FormatClockSpec {
  wheel: WheelSlot[];
  deadAir?: { afterSeconds: number; fill: BumperSource[]; thenAutoProgram?: boolean };
  quietHours?: { from: string; to: string }[];
  minPresentToBroadcast?: number;
  cooldownSeconds?: number;
  maxBumpersPerHour?: number;
}

/** Op-context / format profile (§8). Music selection is R-R4; declared here so
 *  config validates and profiles can be authored ahead of the selection engine. */
export interface RadioProfile {
  name: string;
  music?: {
    select?: Record<string, unknown>;
    playlistRefs?: { platform: "local" | "youtube" | "spotify" | "tidal"; ref: string }[];
    shuffle?: boolean;
    seedQueries?: string[];
    /**
     * Where seedQueries may pull from when building the auto-DJ pool.
     * Default: `["local", "youtube"]` — ~33% library / ~66% short YT tracks when both hit.
     * `stream` only matches Spotify/Tidal/Icecast **URLs** in a seed line (bridge).
     * Free-text Tidal/Spotify rotation still uses `playlistRefs`.
     */
    seedSources?: Array<"local" | "youtube" | "stream">;
    /**
     * Target share of the seed pool from non-local sources (0–1). Default **⅔** (~66%).
     * Thin library → external may exceed this; no external hits → all local.
     */
    seedExternalRatio?: number;
    relayUrl?: string | null;
    /** Seconds between timer bumpers while relaying (R-R6; default 300). */
    relayBumperIntervalSec?: number;
    ratingMin?: number;
    harmonicSequencing?: boolean;
    /**
     * ACE-Step fill when this profile's library/seed pool is empty.
     * - `true` — generate if ACE-Step is enabled + reachable (even when global radio auto-fill is off)
     * - `false` — never ACE-fill for this profile
     * - omit — follow global `aceStepAutoFill`
     */
    aceStepAutoFill?: boolean;
  };
  bumper?: {
    topics?: string[];
    sourceWeights?: Partial<Record<BumperSource, number>>;
    tone?: string;
  };
}

export interface RadioConfig {
  enabled: boolean; // default false
  everyNSongs: number; // default 4; 0 = clock-only (no every-N injection)
  deadAirSeconds: number; // default 25
  maxBumperSeconds: number; // default 30
  /** Volume floor for spoken bumpers/liners (0-100). Speech plays at
   *  max(player volume, this) so it cuts through a low music fader. */
  speechVolumePct: number; // default 85
  minPresentToBroadcast: number;
  /**
   * Stop music + clear queue when **no humans** remain (only the bot left).
   * Seconds of empty grace: **0** = stop immediately (default).
   * **-1** = never stop (legacy keep-playing-when-empty).
   * **N > 0** = wait N seconds empty, then stop.
   */
  emptyChannelStopSeconds: number;
  cooldownSeconds: number;
  maxBumpersPerHour: number;
  quietHours: { from: string; to: string }[];
  sources: BumperSource[];
  memoryBroadcastOptIn: boolean; // default false — org-namespace only (OQ1)
  classificationFloor?: string[]; // override; default = lowest-present (R-R4)
  activeProfile: string;
  profiles: Record<string, RadioProfile>;
  clock?: FormatClockSpec;
  ttsVoice?: string;
  /**
   * Spoken station-ID liners (`stationId` source). One line per entry.
   * `{name}` / `{station}` expands to the bot/station display name.
   * Empty / omit → built-in defaults ("This is {name}.", etc.).
   */
  stationIdLines?: string[];
  /**
   * IANA time zones for the `timeCheck` bumper (e.g. `America/New_York`).
   * Optional `Zone|Spoken label` form: `Europe/London|London`.
   * Empty / omit → host local timezone only.
   */
  timeCheckTimezones?: string[];
  /** Directory holding prerecorded bumper assets (R-R1 pool; R-R2 adds the
   *  tag-flagged overlay). Relative paths resolve against the data dir. */
  bumperDir?: string;
  // OQ2: keyfinder+aubio is the only shipped analyzer tool (essentia/bliss removed from product surface).
  analyzer?: { enabled: boolean; tool: "keyfinder"; onIngest: boolean };
  // OQ7: gentle rating-weighted rotation, radio-mode only.
  ratingWeight?: { enabled: boolean; exponent: number; maxRatio: number };
  /**
   * Auto-DJ play-count cooldown (dead-air restock / profile program only).
   * If a song was played `maxPlays`+ times within the last `cooldownHours`,
   * it is skipped when building the radio pool. Manual !play is unaffected.
   * Default: maxPlays 1, cooldownHours 12 (once played → out for 12h).
   */
  autoDjRepeat?: {
    enabled?: boolean;
    maxPlays?: number;
    cooldownHours?: number;
  };
  // OQ5: harmonic ordering of the upcoming queue window (per profile).
  harmonicSequencing?: boolean;
  /**
   * Smart rotation (Auto-DJ pool ordering). Pure post-selection reorder:
   * artist/album separation → rating weight → energy bias → harmonic.
   * Off fields fall back to defaults in smart-rotation.ts; `enabled: false`
   * on a sub-policy disables that stage only.
   */
  smartRotation?: {
    /** Artist/album spacing windows. Default on when smartRotation is present. */
    separation?: {
      enabled?: boolean;
      artistWindow?: number;
      albumWindow?: number;
      relaxOnEmpty?: boolean;
    };
    /** Soft energy continuity (needs TagStore energy). Default on. */
    energyBias?: {
      enabled?: boolean;
      maxJump?: number;
    };
  };
  /**
   * Music "color" overlay (ffmpeg -af): off | am | fm | telephone | vinyl | lofi.
   * Applied to music decode only; spoken bumpers stay clean. Default off.
   */
  audioColor?: import("./audio-color.js").AudioColorPreset;
  /** Optional Icecast tee (R-R6) — second PCM sink; default off. */
  icecast?: { enabled: boolean; mountUrl: string; format?: "mp3" | "ogg" | "opus" };
}

export function defaultRadioConfig(): RadioConfig {
  return {
    enabled: false,
    everyNSongs: 4,
    deadAirSeconds: 25,
    maxBumperSeconds: 30,
    speechVolumePct: 85,
    minPresentToBroadcast: 1,
    // 10s grace, not 0: the TS6 clientlist channel filter can transiently
    // undercount to zero with listeners present, and stopForEmptyChannel wipes
    // the queue — never fire on a single spurious zero-count poll.
    emptyChannelStopSeconds: 10,
    cooldownSeconds: 180,
    maxBumpersPerHour: 12,
    quietHours: [],
    sources: ["prerecorded", "stationId", "timeCheck", "nowPlaying"],
    stationIdLines: [],
    timeCheckTimezones: [],
    memoryBroadcastOptIn: false,
    activeProfile: "lobby",
    profiles: {
      // Topic packs (R1) align with common doctrine filenames/headings:
      // station/welcome, ops/briefing, combat-doctrine/ROE, mining/logistics.
      lobby: {
        name: "lobby",
        music: { seedQueries: ["chill", "ambient"], shuffle: true },
        bumper: {
          topics: ["station", "welcome", "org announcements", "code of conduct"],
          // Align with DEFAULT_SYSTEM_PROMPT (Colonel Moneypenny persona).
          tone: "Colonel Moneypenny: dry poised British colonel-and-secretary wit, mock-formal teasing, brief and elegant, never crude",
        },
      },
      focus: {
        name: "focus",
        music: {
          select: { mood: ["calm"], bpmMax: 110 },
          seedQueries: ["focus", "ambient"],
          shuffle: true,
        },
        bumper: {
          topics: ["ops", "briefing", "standup", "priorities"],
          tone: "Colonel Moneypenny: dry British composure, calm mock-formal field-grade briefing manner, brief and sharp",
        },
      },
      combat: {
        name: "combat",
        music: {
          seedQueries: ["combat music", "epic battle", "drum and bass"],
          shuffle: true,
        },
        bumper: {
          topics: ["combat doctrine", "ROE", "engagement", "fleet ops"],
          tone: "Colonel Moneypenny under pressure: dry British composure, clipped mock-formal urgency, still arch, never shouty",
        },
      },
      mining: {
        name: "mining",
        music: {
          seedQueries: ["space ambient", "industrial", "mining"],
          shuffle: true,
        },
        bumper: {
          topics: ["mining", "logistics", "refinery", "cargo"],
          tone: "Colonel Moneypenny: dry British efficiency, practical logistics manner, brief",
        },
      },
    },
    ratingWeight: { enabled: true, exponent: 1, maxRatio: 3 },
    autoDjRepeat: { enabled: true, maxPlays: 1, cooldownHours: 12 },
    harmonicSequencing: false,
    // Separation + energy bias on for Auto-DJ; no-ops when meta is missing.
    smartRotation: {
      separation: { enabled: true, artistWindow: 4, albumWindow: 6, relaxOnEmpty: true },
      energyBias: { enabled: true, maxJump: 0.35 },
    },
    analyzer: { enabled: false, tool: "keyfinder", onIngest: true },
    audioColor: "off",
  };
}
