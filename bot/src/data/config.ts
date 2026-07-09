import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RightsConfig } from "../rights/index.js";
import { type VoiceConfig, defaultVoiceConfig } from "../voice/index.js";
import { type RadioConfig, defaultRadioConfig } from "../radio/index.js";

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
  // Public base URL used when generating share links (e.g. the bot's dedicated link).
  // Leave empty to use the browser's current origin. Example:
  //   "https://music.example.com" or "http://1.2.3.4:3000"
  publicUrl: string;
  // When true, Express trusts X-Forwarded-* headers from a reverse proxy
  // (nginx/Caddy/Cloudflare). Required for correct protocol/host detection
  // behind HTTPS-terminating proxies.
  trustProxy: boolean;
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
  // === Retrieval / RAG (ROADMAP Phase 5) ===
  // When true, the bot embeds ingested docs into a vector DB and injects the
  // top-k relevant chunks into `!ask`. Off by default. Endpoint/model are
  // config-driven so the SAME code serves RK3588 and x86+GPU (EmbeddingGemma on
  // ollama by default) — each pointable local or remote.
  ragEnabled: boolean;
  // Qdrant base URL (vector store).
  vectorDbUrl: string;
  // OpenAI-compatible embeddings endpoint. Empty → falls back to the LLM/ollama URL.
  embeddingUrl: string;
  // Embedding model (default embeddinggemma — Gemma-family, all platforms).
  embeddingModel: string;
  // How many chunks to retrieve and inject into `!ask`.
  ragTopK: number;
  // Qdrant collection name for the doc corpus.
  ragCollection: string;
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
  // === TeamSpeak file-browser ingestion (ROADMAP Phase 6, TS-native path) ===
  // When true, the bot polls a hardcoded drop channel's file repository and
  // ingests new files by type: .md/.markdown → doctrine RAG, audio → the music
  // library. Off by default. The channel name is a code constant
  // (FILE_DROP_CHANNEL_NAME); the security boundary is the channel's TS upload
  // permission. See bot/src/ingest/file-drop.ts.
  fileDropEnabled: boolean;
  // How often (seconds) to poll the drop channel for new files.
  fileDropPollSec: number;
}

export function getDefaultConfig(): BotConfig {
  return {
    webPort: 3000,
    bindAddress: "127.0.0.1",
    locale: "en",
    theme: "dark",
    commandPrefix: "!",
    commandAliases: { p: "play", s: "skip", n: "next" },
    pokeCommandsEnabled: true,
    pokeCommandsPerMinute: 12,
    adminPassword: "",
    adminGroups: [],
    autoReturnDelay: 300,
    autoPauseOnEmpty: true,
    idleTimeoutMinutes: 0,
    publicUrl: "",
    trustProxy: false,
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
    // Endpoint/model default empty → the clients use their built-in defaults
    // (qdrant:6333 / ollama / embeddinggemma) or the VECTOR_DB_URL /
    // EMBEDDING_URL / EMBEDDING_MODEL env vars install.sh writes (two-track).
    ragEnabled: false,
    vectorDbUrl: "",
    embeddingUrl: "",
    embeddingModel: "",
    ragTopK: 4,
    ragCollection: "moneypenny_docs",
    memoryEnabled: false,
    mempalaceEnabled: false,
    mempalaceUrl: "",
    kgEnabled: false,
    fileDropEnabled: false,
    fileDropPollSec: 30,
  };
}

export function loadConfig(path: string): BotConfig {
  const defaults = getDefaultConfig();
  try {
    const raw = readFileSync(path, "utf-8");
    const partial = JSON.parse(raw) as Partial<BotConfig>;
    return { ...defaults, ...partial };
  } catch {
    return defaults;
  }
}

export function saveConfig(path: string, config: BotConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}
