/**
 * @moneypenny/ts6-client — TeamSpeak 3/6 dual-protocol client.
 *
 * Formerly `bot/src/ts-protocol/`. Hosts inject a logger (pino-compatible).
 */

export type { FileUploadInfo } from "@honeybbq/teamspeak-client";

export {
  CODEC_OPUS_MUSIC,
  CODEC_OPUS_VOICE,
  VoiceConnection,
  type VoiceOptions,
} from "./voice.js";

export {
  TS3Client,
  escapeTS3,
  extractFileRows,
  parseFtFileList,
  type ChannelFile,
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

export {
  HttpQueryError,
  TS6HttpQuery,
  type HttpQueryOptions,
  type HttpQueryResult,
} from "./http-query.js";

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

export {
  VoiceTransportHealth,
  type VoiceTransportHealthOptions,
} from "./voice-transport-health.js";

export type { Logger, Ts6Logger } from "./logger.js";
