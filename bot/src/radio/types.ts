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
    relayUrl?: string | null;
    /** Seconds between timer bumpers while relaying (R-R6; default 300). */
    relayBumperIntervalSec?: number;
    ratingMin?: number;
    harmonicSequencing?: boolean;
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
  /** Directory holding prerecorded bumper assets (R-R1 pool; R-R2 adds the
   *  tag-flagged overlay). Relative paths resolve against the data dir. */
  bumperDir?: string;
  // OQ2: keyfinder+aubio is the only shipped analyzer tool (essentia/bliss removed from product surface).
  analyzer?: { enabled: boolean; tool: "keyfinder"; onIngest: boolean };
  // OQ7: gentle rating-weighted rotation, radio-mode only.
  ratingWeight?: { enabled: boolean; exponent: number; maxRatio: number };
  // OQ5: harmonic ordering of the upcoming queue window (per profile).
  harmonicSequencing?: boolean;
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
    cooldownSeconds: 180,
    maxBumpersPerHour: 12,
    quietHours: [],
    sources: ["prerecorded", "stationId", "timeCheck", "nowPlaying"],
    memoryBroadcastOptIn: false,
    activeProfile: "lobby",
    profiles: {
      lobby: {
        name: "lobby",
        music: { seedQueries: ["chill", "ambient"], shuffle: true },
        bumper: { topics: ["station", "welcome"] },
      },
      focus: {
        name: "focus",
        music: {
          select: { mood: ["calm"], bpmMax: 110 },
          seedQueries: ["focus", "ambient"],
          shuffle: true,
        },
        bumper: { topics: ["ops", "briefing"] },
      },
    },
    ratingWeight: { enabled: true, exponent: 1, maxRatio: 3 },
    harmonicSequencing: false,
    analyzer: { enabled: false, tool: "keyfinder", onIngest: true },
    audioColor: "off",
  };
}
