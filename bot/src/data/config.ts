import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RightsConfig } from "../rights/index.js";
import { type VoiceConfig, defaultVoiceConfig } from "../voice/index.js";

export interface BotConfig {
  webPort: number;
  // Network interface the web server binds to (DESIGN §11). Default 127.0.0.1
  // — localhost-only, safe by default for bare-metal. In Docker set
  // BIND_ADDRESS=0.0.0.0 (the published port is restricted host-side instead).
  bindAddress: string;
  locale: "zh" | "en";
  theme: "dark" | "light";
  commandPrefix: string;
  commandAliases: Record<string, string>;
  adminPassword: string;
  adminGroups: number[];
  autoReturnDelay: number;
  autoPauseOnEmpty: boolean;
  idleTimeoutMinutes: number;
  // Public base URL used when generating share links (e.g. the bot专属链接).
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
  // the client default (qwen3-1.7b).
  llmModel: string;
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
  // === Voice pipeline (Phase 2, DESIGN §10) ===
  // Inbound voice loop (VAD/STT → router → TTS). Disabled by default; requires
  // the sherpa-onnx / Kokoro sidecars and is unvalidated against real hardware.
  voice: VoiceConfig;
  // === Stream bridge (Phase 3, DESIGN §7.3) ===
  // Base URL of an external Spotify/Tidal stream bridge (librespot/ncspot).
  // Empty → only direct http(s)/Icecast stream URLs are playable.
  streamBridgeUrl: string;
}

export function getDefaultConfig(): BotConfig {
  return {
    webPort: 3000,
    bindAddress: "127.0.0.1",
    locale: "en",
    theme: "dark",
    commandPrefix: "!",
    commandAliases: { p: "play", s: "skip", n: "next" },
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
    rightsEnabled: true,
    voice: defaultVoiceConfig(),
    streamBridgeUrl: "",
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
