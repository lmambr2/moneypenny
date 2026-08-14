import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RightsConfig } from "../rights/index.js";
import { type VoiceConfig, defaultVoiceConfig } from "../voice/index.js";
import { type RadioConfig, defaultRadioConfig } from "../radio/index.js";
import { type BotScopeConfig, defaultBotScope } from "../bot/scope.js";
import {
  type SessionRolesConfig,
  defaultSessionRolesConfig,
} from "../bot/lifecycle/session-roles.js";
import { DEFAULT_MUSIC_BLOCKED_GENRES } from "../music/genre-block.js";

export interface BotConfig {
  webPort: number;
  // Network interface the web server binds to (DESIGN §11). Default 127.0.0.1
  // — localhost-only, safe by default for bare-metal. In Docker set
  // BIND_ADDRESS=0.0.0.0 (the published port is restricted host-side instead).
  bindAddress: string;
  locale: "en";
  theme: "dark" | "light";
  commandPrefix: string;
  commandAliases: Record<string, string>;
  /**
   * When true (default), TeamSpeak pokes to the bot are treated as commands
   * (same ControlRouter as chat/voice; `!` prefix optional). See docs/BUILD.md P0.
   */
  pokeCommandsEnabled: boolean;
  /** Max poke-commands accepted per invoker per rolling minute (default 12). */
  pokeCommandsPerMinute: number;
  adminPassword: string;
  adminGroups: number[];
  autoReturnDelay: number;
  autoPauseOnEmpty: boolean;
  idleTimeoutMinutes: number;
  /**
   * Temporary Session / … server groups for voice priority (not rights ranks).
   * See docs/voice-priority-session-discipline.md and !session clear.
   */
  sessionRoles: SessionRolesConfig;
  /**
   * Follow the crowd: when nobody is left in the bot's channel, move to the
   * busiest channel that has people in it. Off by default — a bot that relocates
   * itself is surprising unless you asked for it.
   */
  /**
   * Artists that !ban / the web ban endpoint must refuse. Matched against BOTH
   * title and artist (re-uploads put the real artist in the title), so keep
   * entries specific enough not to over-match.
   */
  playbackBanProtectedArtists: string[];
  autoFollowEnabled: boolean;
  /**
   * Channel names never followed into, matched case-insensitively. AFK is the
   * point of the feature: people parked there do not want a DJ to arrive.
   */
  autoFollowAfkChannels: string[];
  /** Minimum gap between automatic moves, so a tie or a churning channel cannot make the bot hop. */
  autoFollowCooldownSec: number;
  // Public base URL used when generating share links (e.g. the bot's dedicated link).
  // Leave empty to use the browser's current origin. Example:
  //   "https://music.example.com" or "http://1.2.3.4:3000"
  publicUrl: string;
  // When true, Express trusts X-Forwarded-* headers from a reverse proxy
  // (nginx/Caddy/Cloudflare). Required for correct protocol/host detection
  // behind HTTPS-terminating proxies.
  trustProxy: boolean;
  /**
   * Trusted reverse-proxy hop count for rate-limit IP keys (audit M-2026-07-09-3).
   * Only the rightmost N X-Forwarded-For entries are used when trustProxy is on.
   * Default 1 — set to match your edge proxy chain (never higher than needed).
   */
  trustProxyHops: number;
  /** H6 — preferred channel/server labels for multi-bot ops. */
  scope: BotScopeConfig;
  /**
   * Harness intent: allow stop/vol/move tools (default false — safety policy).
   */
  harnessIntentAllowDangerous: boolean;
  /** Dashboard recording feature enabled (default false — opt-in). */
  recordingsEnabled: boolean;
  // === LLM (Phase 1b, DESIGN §9) ===
  // When true, the ControlRouter wires the in-process RKLLama client so that
  // `!ask <question>` answers via the NPU-backed LLM and unrecognized prefixed
  // input is routed to LLM tool-calling for fuzzy music intent. Default off so
  // a down/absent RKLLama never stalls command handling on a request timeout.
  llmEnabled: boolean;
  // RKLLama OpenAI-compatible base URL. Empty → falls back to the RKLLAMA_URL
  // env var, then the client default (http://localhost:8080).
  llmUrl: string;
  // Model name passed to /v1/chat/completions. Empty → RKLLAMA_MODEL env, then
  // the client default (Gemma 4 E2B QAT GGUF).
  llmModel: string;
  // Optional secondary LLM (e.g. Pi NotPunchnox/rkllama) used when the primary
  // endpoint is unreachable. Empty → no fallback.
  llmFallbackUrl: string;
  llmFallbackModel: string;
  // Heavy analyst endpoint (DESIGN §R1). Empty → delegation disabled.
  llmDelegateUrl: string;
  llmDelegateModel: string;
  // System prompt / persona for the LLM. Empty → the built-in
  // DEFAULT_SYSTEM_PROMPT. Use this to set the bot's personality or pin the
  // reply language (e.g. "Always respond in English.").
  llmSystemPrompt: string;
  // Sampling temperature (0 = deterministic, higher = more varied). Default 0.2.
  llmTemperature: number;
  // === Roast / community layer (ROADMAP Phase 8) ===
  // When true, the bot captures members' chat lines, LLM-grades them for cringe,
  // and auto-compiles a "greatest hits" reel when enough people are present.
  // Off by default (opt-in — it records + mocks people). Requires the LLM.
  roastEnabled: boolean;
  // Minimum distinct humans in the bot's channel to auto-fire a compilation.
  roastMinPresent: number;
  // Cooldown between auto-compilations so it's a treat, not spam.
  roastCooldownMinutes: number;
  // Minimum cringe score (0–10) for a line to appear in a reel.
  roastMinScore: number;
  // === Rank gating (Phase 1c, DESIGN §8) ===
  // When true, the ControlRouter enforces the rights model against the
  // invoker's TeamSpeak server-groups. Default ON (fail-safe): the derived
  // default ruleset lets everyone run public/music commands but denies admin
  // commands until `adminGroups` is set, so privileged + LLM-driven actions are
  // never ungated out of the box (audit F-4). Set false to opt out explicitly.
  rightsEnabled: boolean;
  // Optional explicit rights ruleset. When omitted, a default is derived from
  // `adminGroups` (everyone gets public commands; admin groups also get admin
  // commands). The same LLM-driven action is gated identically — no escalation
  // via natural language.
  rights?: RightsConfig;
  /** Last applied rights delta (src/rights/migrations.ts). Absent = 0. */
  rightsSchemaVersion?: number;
  // === Voice pipeline (Phase 2, DESIGN §10) ===
  // Inbound voice loop (VAD/STT → router → TTS). Disabled by default; requires
  // the sherpa-onnx / Kokoro sidecars and is unvalidated against real hardware.
  voice: VoiceConfig;
  // === Radio / autonomous DJ (docs/radio.md) ===
  // Program director over the single-stream player: bumpers every N songs / on
  // dead air. Off by default — enabled=false is byte-identical to today.
  radio: RadioConfig;
  // === Stream bridge (Phase 3, DESIGN §7.3) ===
  // Base URL of an external Spotify/Tidal stream bridge (librespot/ncspot).
  // Empty → only direct http(s)/Icecast stream URLs are playable.
  streamBridgeUrl: string;
  // === YouTube → local library (ROADMAP adjacent feature) ===
  // When true, playing a YouTube URL also downloads it as a tagged MP3 into the
  // local library (deduped by video id), so replays serve the saved file. Off by
  // default (downloading is against YouTube ToS — a self-hosted call).
  youtubeSaveEnabled: boolean;
  /**
   * Opus bitrate for music frames sent to TeamSpeak (kbps).
   * 0 = Auto (libopus). Typical: 48–64 Starlink-friendly, 96–128 high quality.
   * Clamped 24–160 when non-zero. Hot-applied on Settings save.
   */
  musicOpusBitrateKbps: number;
  /**
   * Genre terms blocked from search / queue / radio seed (title, artist, album,
   * and local genre tags). Default: rap / hip-hop / R&B family.
   * Explicit `[]` disables the policy. See `music/genre-block.ts`.
   */
  musicBlockedGenres: string[];
  // === Retrieval / RAG (ROADMAP Phase 5) ===
  // When true, the bot embeds ingested docs into a vector DB and injects the
  // top-k relevant chunks into `!ask`. Off by default. Endpoint/model are
  // config-driven: SBC default nomic-embed-text-v2-moe; Server may use
  // bge-large-en-v1.5 — each pointable local or remote.
  ragEnabled: boolean;
  // TurboVec bridge base URL (vector store; Qdrant-shaped REST).
  vectorDbUrl: string;
  // OpenAI-compatible embeddings endpoint. Empty → falls back to the LLM/ollama URL.
  embeddingUrl: string;
  // Embedding model (env EMBEDDING_MODEL / edition default when empty).
  embeddingModel: string;
  // How many chunks to retrieve and inject into `!ask`.
  ragTopK: number;
  // Vector collection name for the doc corpus.
  ragCollection: string;
  /** Optional cross-encoder base URL (TEI /rerank). Empty = off. */
  rerankerUrl: string;
  /** Reranker model id (default bge-reranker-large). */
  rerankerModel: string;
  // === Per-user memory (ROADMAP Phase 7, MVP) ===
  // When true, `!remember`-ed facts for the asking user are injected into `!ask`.
  // Off by default. The facts are stored regardless; this only gates injection.
  memoryEnabled: boolean;
  // MemPalace semantic memory sidecar (Phase 7). When enabled + URL set, facts
  // sync to the bridge and `!ask` uses semantic recall instead of SQLite list.
  mempalaceEnabled: boolean;
  mempalaceUrl: string;
  // Institutional knowledge graph (Phase 7). Injects org facts into !ask when on.
  kgEnabled: boolean;
  /** Optional Star Citizen / org status bridge base URL (G2). Empty = fail-open. */
  scOrgStatusUrl: string;
  /** Display name for SC org status lines. */
  scOrgName: string;
  // === TeamSpeak file-browser ingestion (ROADMAP Phase 6, TS-native path) ===
  // When true, the bot polls a hardcoded drop channel's file repository and
  // ingests new files by type: .md/.markdown → doctrine RAG, audio → the music
  // library. Off by default. The channel name is a code constant
  // (FILE_DROP_CHANNEL_NAME); the security boundary is the channel's TS upload
  // permission. See bot/src/ingest/file-drop.ts.
  fileDropEnabled: boolean;
  // How often (seconds) to poll the drop channel for new files.
  fileDropPollSec: number;
  // === ACE-Step music generation (docs/ace-step.md) — optional LAN sidecar ===
  aceStepEnabled: boolean;
  aceStepUrl: string;
  aceStepAutoFill: boolean;
  aceStepTimeoutMs: number;
  /** Subdir under MUSIC_DIR for generated files. */
  aceStepOutputDir: string;
  /** Keep at most this many files in the output dir (oldest pruned after gen). 0 = no prune. */
  aceStepMaxFiles: number;
  /**
   * Event-driven reconnect after unexpected TS drops (S-OC3).
   * Watchdog remains a backup; this recovers in seconds with exp backoff.
   */
  reconnect: {
    /** Default true — schedule reconnect on remote disconnect for autoStart bots. */
    eventDriven: boolean;
    /** First retry delay ms (default 2000). */
    baseMs: number;
    /** Cap delay ms (default 60000). */
    maxMs: number;
    /** S-OC2: sendVoice errors in window before reconnect (default 5). */
    voiceErrorThreshold?: number;
    /** S-OC2: window ms for voice errors (default 30000). */
    voiceErrorWindowMs?: number;
    /** S-OC2: successful sends to clear latch (default 20). */
    voiceHealthyReset?: number;
  };
  /**
   * Typed memory budgets + injection dedup (P2). All optional; defaults in turn-context.
   */
  memoryContext?: {
    workingTurns?: number;
    doctrineChunks?: number;
    orgKgHits?: number;
    playbooks?: number;
    lastTools?: number;
    dedupeInjections?: boolean;
    playbooksEnabled?: boolean;
    playbookCapture?: boolean;
  };
  /** Claim-check RAG (P1). Default off. */
  ragClaimCheck?: {
    enabled?: boolean;
    maxClaims?: number;
    maxExtraRetrieves?: number;
    revise?: boolean;
    timeoutMs?: number;
  };
  /** Clarify-once on ambiguous intent (P4). Default off. */
  intentClarifyOnce?: boolean;
}

export function getDefaultConfig(): BotConfig {
  return {
    webPort: 3000,
    bindAddress: "127.0.0.1",
    locale: "en",
    theme: "dark",
    commandPrefix: "!",
    // n→skip (bare advance). Jump/start a title: !jump / !go. pn is a real command.
    commandAliases: { p: "play", s: "skip", n: "skip" },
    pokeCommandsEnabled: true,
    pokeCommandsPerMinute: 12,
    adminPassword: "",
    adminGroups: [],
    autoReturnDelay: 300,
    autoPauseOnEmpty: true,
    idleTimeoutMinutes: 0,
    sessionRoles: defaultSessionRolesConfig(),
    playbackBanProtectedArtists: [],
    autoFollowEnabled: false,
    autoFollowAfkChannels: ["AFK", "Away", "AFK / Away"],
    autoFollowCooldownSec: 60,
    publicUrl: "",
    trustProxy: false,
    trustProxyHops: 1,
    scope: defaultBotScope(),
    harnessIntentAllowDangerous: false,
    recordingsEnabled: false,
    llmEnabled: false,
    llmUrl: "",
    llmModel: "",
    llmFallbackUrl: "",
    llmFallbackModel: "",
    llmDelegateUrl: "",
    llmDelegateModel: "",
    llmSystemPrompt: "",
    llmTemperature: 0.2,
    roastEnabled: false,
    roastMinPresent: 3,
    roastCooldownMinutes: 180,
    roastMinScore: 4,
    rightsEnabled: true,
    voice: defaultVoiceConfig(),
    radio: defaultRadioConfig(),
    streamBridgeUrl: "",
    youtubeSaveEnabled: false,
    // Default 64 kbps: solid stereo music, ~half the uplink of 128k full music.
    musicOpusBitrateKbps: 64,
    musicBlockedGenres: [...DEFAULT_MUSIC_BLOCKED_GENRES],
    // Endpoint/model default empty → clients use env / edition defaults
    // (turbovec:6333 / ollama / nomic-embed-text-v2-moe or bge-large-en-v1.5).
    ragEnabled: false,
    vectorDbUrl: "",
    embeddingUrl: "",
    embeddingModel: "",
    ragTopK: 6,
    ragCollection: "moneypenny_docs",
    rerankerUrl: "",
    rerankerModel: "bge-reranker-large",
    memoryEnabled: false,
    mempalaceEnabled: false,
    mempalaceUrl: "",
    kgEnabled: false,
    scOrgStatusUrl: process.env.SC_ORG_STATUS_URL ?? "",
    scOrgName: process.env.SC_ORG_NAME ?? "",
    fileDropEnabled: false,
    fileDropPollSec: 30,
    aceStepEnabled: false,
    aceStepUrl: "",
    aceStepAutoFill: false,
    aceStepTimeoutMs: 300_000,
    aceStepOutputDir: "generated/ace-step",
    aceStepMaxFiles: 40,
    reconnect: {
      eventDriven: true,
      baseMs: 2_000,
      maxMs: 60_000,
      voiceErrorThreshold: 5,
      voiceErrorWindowMs: 30_000,
      voiceHealthyReset: 20,
    },
    memoryContext: {
      workingTurns: 6,
      doctrineChunks: 8,
      dedupeInjections: true,
      playbooksEnabled: false,
      playbookCapture: false,
    },
    ragClaimCheck: { enabled: false },
    intentClarifyOnce: false,
  };
}

/** Nested objects that must deep-merge so sparse Settings saves keep sibling defaults (M-CFG-1). */
const DEEP_MERGE_KEYS = [
  "reconnect",
  "memoryContext",
  "ragClaimCheck",
  "voice",
  "radio",
  "scope",
  "sessionRoles",
] as const;

/**
 * Merge partial config onto defaults. Top-level is shallow; known nested keys
 * deep-merge one level so `{ reconnect: { eventDriven: false } }` keeps baseMs/maxMs.
 */
export function mergeBotConfig(defaults: BotConfig, partial: Partial<BotConfig>): BotConfig {
  const out = { ...defaults, ...partial } as BotConfig;
  for (const key of DEEP_MERGE_KEYS) {
    const d = defaults[key as keyof BotConfig];
    const p = partial[key as keyof BotConfig];
    if (
      d &&
      typeof d === "object" &&
      !Array.isArray(d) &&
      p &&
      typeof p === "object" &&
      !Array.isArray(p)
    ) {
      (out as unknown as Record<string, unknown>)[key] = {
        ...(d as Record<string, unknown>),
        ...(p as Record<string, unknown>),
      };
    }
  }
  return out;
}

export function loadConfig(path: string): BotConfig {
  const defaults = getDefaultConfig();
  try {
    const raw = readFileSync(path, "utf-8");
    const partial = JSON.parse(raw) as Partial<BotConfig>;
    return mergeBotConfig(defaults, partial);
  } catch {
    return defaults;
  }
}

export function saveConfig(path: string, config: BotConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}
