/**
 * `@moneypenny/ts6-client` — TeamSpeak 3/6 dual-protocol client (PR-B1/B2).
 *
 * ## Public surface (prefer this barrel)
 *
 * | Area | Symbols |
 * |------|---------|
 * | **Connect** | `TS3Client`, `TS3ClientOptions`, `ServerProtocol`, `detectServerProtocol` |
 * | **Text / poke** | `TS3TextMessage`, `TS3Poke`, `escapeTS3` |
 * | **Voice** | `TS3VoiceData`, `CODEC_OPUS_VOICE`, `CODEC_OPUS_MUSIC`, `VoiceConnection` |
 * | **File drop** | `ChannelFile`, `parseFtFileList`, `extractFileRows`, `FileUploadInfo` |
 * | **Query helpers** | `HttpQueryError`, `TS6HttpQuery`, `QueryClient`, move-resolver utils |
 * | **Logger inject** | `Ts6Logger` (pino-compatible duck type) |
 *
 * Subpath imports (`@moneypenny/ts6-client/voice`, …) remain for advanced use
 * but the bot host should import only from `@moneypenny/ts6-client`.
 *
 * Dual-protocol detection: see package README and `docs/ts6-client.md`.
 */

// ── Connect + client ───────────────────────────────────────────────────────
export type { FileUploadInfo } from "@honeybbq/teamspeak-client";

export {
  TS3Client,
  escapeTS3,
  extractFileRows,
  parseFtFileList,
  type ChannelFile,
  type TS3ClientEventMap,
  type TS3ClientOptions,
  type TS3Poke,
  type TS3TextMessage,
  type TS3VoiceData,
} from "./client.js";

export type { ServerProtocol } from "./protocol-detect.js";
export {
  detectServerProtocol,
  type DetectOptions,
  type ProtocolDetectResult,
} from "./protocol-detect.js";

// ── Voice ──────────────────────────────────────────────────────────────────
export {
  CODEC_OPUS_MUSIC,
  CODEC_OPUS_VOICE,
  VoiceConnection,
  type VoiceOptions,
} from "./voice.js";

export {
  VoiceTransportHealth,
  type VoiceTransportHealthOptions,
} from "./voice-transport-health.js";

// ── HTTP Query (TS6) ───────────────────────────────────────────────────────
export {
  HttpQueryError,
  TS6HttpQuery,
  type HttpQueryOptions,
  type HttpQueryResult,
} from "./http-query.js";

// ── Move / presence helpers ────────────────────────────────────────────────
export {
  extractQueryRows,
  parseChannelRows,
  parseClientRows,
  resolveChannelQuery,
  resolveClientQuery,
  serverGroupsByClidFromRows,
  type QueryChannel,
  type QueryClient,
  type ResolveResult,
} from "./move-resolver.js";

export {
  asChannelId,
  filterClientsInChannel,
  resolveOwnChannelId,
  sameChannelId,
} from "./channel-presence.js";

// ── Encoding / identity (advanced) ─────────────────────────────────────────
export {
  decodeResponse,
  encodeCommand,
  escapeValue,
  parseErrorLine,
  unescapeValue,
} from "./commands.js";

export {
  computeUid,
  exportIdentity,
  generateIdentity,
  importIdentity,
  type TS3Identity,
} from "./identity.js";

export type { Logger, Ts6Logger } from "./logger.js";
