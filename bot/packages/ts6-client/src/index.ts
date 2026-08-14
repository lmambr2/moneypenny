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
  asChannelId,
  type BusiestChannelOpts,
  type ChannelPopulation,
  filterClientsInChannel,
  pickBusiestChannel,
  resolveOwnChannelId,
  sameChannelId,
  tallyChannelPopulations,
} from "./channel-presence.js";
export {
  type ChannelFile,
  escapeTS3,
  extractFileRows,
  parseFtFileList,
  TS3Client,
  type TS3ClientEventMap,
  type TS3ClientOptions,
  type TS3Poke,
  type TS3TextMessage,
  type TS3VoiceData,
} from "./client.js";
// ── Encoding / identity (advanced) ─────────────────────────────────────────
export {
  decodeResponse,
  encodeCommand,
  escapeValue,
  parseErrorLine,
  unescapeValue,
} from "./commands.js";
// ── HTTP Query (TS6) ───────────────────────────────────────────────────────
export {
  HttpQueryError,
  type HttpQueryOptions,
  type HttpQueryResult,
  TS6HttpQuery,
} from "./http-query.js";
export {
  computeUid,
  exportIdentity,
  generateIdentity,
  importIdentity,
  type TS3Identity,
} from "./identity.js";
export type { Logger, Ts6Logger } from "./logger.js";

// ── Move / presence helpers ────────────────────────────────────────────────
export {
  extractQueryRows,
  parseChannelRows,
  parseClientRows,
  type QueryChannel,
  type QueryClient,
  type ResolveResult,
  resolveChannelQuery,
  resolveClientQuery,
  serverGroupsByClidFromRows,
} from "./move-resolver.js";
export type { ServerProtocol } from "./protocol-detect.js";
export {
  type DetectOptions,
  detectServerProtocol,
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
