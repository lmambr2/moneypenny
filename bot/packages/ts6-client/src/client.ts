import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import {
  type ClientInfo,
  type ClientLeftViewEvent,
  type ClientMovedEvent,
  clientMove,
  downloadFileData,
  type FileDownloadInfo,
  type FileUploadInfo,
  fileTransferDeleteFile,
  generateIdentity as genTS3Identity,
  type Identity,
  identityFromString,
  listChannels,
  listClients,
  type PokeEvent,
  sendTextMessage,
  type TextMessage,
  Client as TS3FullClient,
  poke as tsPoke,
  type VoiceData,
} from "@honeybbq/teamspeak-client";
import {
  asChannelId,
  filterClientsInChannel,
  resolveOwnChannelId as resolveOwnChannelIdPure,
} from "./channel-presence.js";
import { HttpQueryError, TS6HttpQuery } from "./http-query.js";
import type { Logger } from "./logger.js";
import {
  extractQueryRows,
  parseChannelRows,
  parseClientRows,
  type QueryClient,
  resolveChannelQuery,
  resolveClientQuery,
  serverGroupsByClidFromRows,
} from "./move-resolver.js";
import { detectServerProtocol, type ServerProtocol } from "./protocol-detect.js";
import { VoiceTransportHealth } from "./voice-transport-health.js";

export type { FileUploadInfo } from "@honeybbq/teamspeak-client";
export type { ServerProtocol } from "./protocol-detect.js";
export { CODEC_OPUS_MUSIC } from "./voice.js";

/** TS error 770 — clientMove to the channel we're already in. */
function isAlreadyInChannelError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { id?: string | number; serverMessage?: string; message?: string };
  if (String(e.id) === "770") return true;
  const msg = `${e.serverMessage ?? ""} ${e.message ?? ""}`.toLowerCase();
  return msg.includes("already member of channel");
}

/** One entry in a channel's file repository (TS3 `ftgetfilelist`). */
export interface ChannelFile {
  name: string;
  size: bigint;
  /** Server-side mtime, unix seconds (0 if absent). */
  datetime: number;
  /** TS3 file type: 1 = file, 0 = directory. */
  type: number;
}

/**
 * Parse raw `ftgetfilelist` rows into typed entries. Pure (no I/O) so it's unit-
 * testable. Rows missing a `name` are dropped; size/datetime/type are coerced
 * from their string fields (TS3 returns everything as strings).
 */
export function parseFtFileList(rows: Record<string, unknown>[]): ChannelFile[] {
  const out: ChannelFile[] = [];
  for (const r of rows ?? []) {
    const rawName = r?.name;
    if (rawName == null || rawName === "") continue;
    let size = 0n;
    try {
      size = BigInt(String(r.size ?? "0"));
    } catch {
      size = 0n;
    }
    out.push({
      name: String(rawName),
      size,
      datetime: Number.parseInt(String(r.datetime ?? "0"), 10) || 0,
      type: Number.parseInt(String(r.type ?? "1"), 10) || 0,
    });
  }
  return out;
}

/**
 * Pull the file-list array out of a TS6 HTTP Query response. The query wraps
 * results as `{ body: [...], status: {...} }`; tolerate a bare array too.
 */
export function extractFileRows(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === "object") {
    const inner = (body as { body?: unknown }).body;
    if (Array.isArray(inner)) return inner as Record<string, unknown>[];
  }
  return [];
}

/** Escape a string for use in TS3 ServerQuery-style commands. */
export function escapeTS3(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/ /g, "\\s")
    .replace(/\//g, "\\/")
    .replace(/\|/g, "\\p")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

export interface TS3ClientOptions {
  host: string;
  port: number; // Voice/virtual server port (default 9987)
  queryPort: number; // ServerQuery port (10011 for TS3, 10080 for TS6 HTTP)
  nickname: string;
  identity?: string; // Exported identity string, or undefined to generate new
  defaultChannel?: string;
  channelPassword?: string;
  serverPassword?: string;
  /** Force a specific protocol instead of auto-detecting. */
  serverProtocol?: ServerProtocol;
  /** API key for TS6 HTTP Query authentication. */
  ts6ApiKey?: string;
  /** TS6 virtual server id for HTTP Query (default 1). */
  virtualServerId?: number;
}

export interface TS3TextMessage {
  invokerName: string;
  invokerId: string;
  invokerUid: string;
  /** Server-group IDs from the TS client cache (empty when unknown). */
  invokerGroups?: string[];
  message: string;
  targetMode: number; // 1=private, 2=channel, 3=server
}

/** Inbound poke (TeamSpeak poke-as-command channel). */
export interface TS3Poke {
  invokerName: string;
  invokerId: string;
  invokerUid: string;
  message: string;
}

/** Inbound per-speaker voice packet (DESIGN §10 capture). `data` is Opus. */
export interface TS3VoiceData {
  clientId: number;
  codec: number;
  data: Buffer;
}

/**
 * Events emitted by {@link TS3Client} (public surface — PR-B2).
 *
 * Hosts (BotInstance) should only depend on this class + these event names;
 * do not reach into protocol-detect / http-query internals for station ops.
 */
export type TS3ClientEventMap = {
  connected: [];
  disconnected: [];
  textMessage: [TS3TextMessage];
  poke: [TS3Poke];
  voiceData: [TS3VoiceData];
  /** Presence — alone-stop / radio recount (full-client, not Query polling). */
  clientEnter: [ClientInfo];
  clientLeave: [ClientLeftViewEvent];
  clientMoved: [ClientMovedEvent];
  /** S-OC2: sendVoice failure window — hosts should fail open / reconnect. */
  voiceTransportUnhealthy: [];
};

export class TS3Client extends EventEmitter {
  private client: TS3FullClient | null = null;
  private identity: Identity;
  private clientId = 0;
  private logger: Logger;
  private disconnecting = false;
  private detectedProtocol: ServerProtocol = "unknown";
  private httpQuery: TS6HttpQuery | null = null;
  private udpErrorTimer: ReturnType<typeof setTimeout> | null = null;
  /** Ref-count for inbound capture — library drops voice UDP unless a handler is registered. */
  private inboundVoiceConsumers = 0;
  private libraryVoiceBridge: ((v: VoiceData) => void) | null = null;
  private inboundVoicePackets = 0;
  /** S-OC2 — sendVoice failure window → voiceTransportUnhealthy once. */
  private voiceTransportHealth = new VoiceTransportHealth();

  constructor(
    private options: TS3ClientOptions,
    logger: Logger,
  ) {
    super();
    this.logger = logger;

    if (options.identity) {
      this.identity = identityFromString(options.identity);
    } else {
      this.identity = genTS3Identity(8);
    }
  }

  /** The detected (or forced) server protocol after connect(). */
  getServerProtocol(): ServerProtocol {
    return this.detectedProtocol;
  }

  /** TS6 HTTP Query client (available after connecting to a TS6 server). */
  getHttpQuery(): TS6HttpQuery | null {
    return this.httpQuery;
  }

  /** Subscribe to inbound voice — required so @honeybbq/teamspeak-client processes voice UDP. */
  ensureInboundVoiceCapture(): void {
    this.inboundVoiceConsumers++;
    this.attachLibraryVoiceBridge();
  }

  /** Release an inbound-voice subscription (e.g. voice pipeline disabled). */
  releaseInboundVoiceCapture(): void {
    this.inboundVoiceConsumers = Math.max(0, this.inboundVoiceConsumers - 1);
    if (this.inboundVoiceConsumers === 0) {
      this.detachLibraryVoiceBridge();
    }
  }

  private attachLibraryVoiceBridge(): void {
    if (!this.client || this.libraryVoiceBridge) return;
    this.libraryVoiceBridge = (v: VoiceData) => {
      this.inboundVoicePackets++;
      if (this.inboundVoicePackets === 1) {
        this.logger.info(
          { clientId: v.clientId, codec: v.codec, opusBytes: v.data.byteLength },
          "TS voice bridge: first inbound packet from server",
        );
      }
      this.emit("voiceData", {
        clientId: v.clientId,
        codec: v.codec,
        data: Buffer.from(v.data),
      } satisfies TS3VoiceData);
    };
    this.client.on("voiceData", this.libraryVoiceBridge);
  }

  private detachLibraryVoiceBridge(): void {
    if (!this.client || !this.libraryVoiceBridge) return;
    // honeybbq client has no off() — bridge stays for connection lifetime; gate uses #h.length.
    this.libraryVoiceBridge = null;
  }

  async connect(): Promise<void> {
    // Clean up any existing connection before creating a new one
    if (this.client) {
      this.logger.info("Cleaning up previous connection before reconnecting");
      try {
        await this.client.disconnect();
      } catch {
        // Ignore errors during cleanup
      }
      this.client = null;
      this.clientId = 0;
    }

    const addr = `${this.options.host}:${this.options.port}`;

    // Detect or use forced protocol
    if (this.options.serverProtocol && this.options.serverProtocol !== "unknown") {
      this.detectedProtocol = this.options.serverProtocol;
      this.logger.info({ addr, protocol: this.detectedProtocol }, "Using forced server protocol");
    } else {
      this.logger.info({ addr }, "Detecting server protocol (TS3/TS6)...");
      const detection = await detectServerProtocol(this.options.host, this.options.port, 3000, {
        ts3QueryPort: 10011,
        ts6HttpPort: 10080,
      });
      this.detectedProtocol = detection.protocol;
      if (this.detectedProtocol === "unknown") {
        this.logger.warn(
          { addr },
          "Could not detect server protocol (query ports 10011/10080 unreachable). " +
            "Will attempt voice connection anyway. Use serverProtocol option to force TS3 or TS6.",
        );
      } else {
        this.logger.info(
          { addr, protocol: this.detectedProtocol, queryPort: detection.queryPort },
          `Server protocol detected: ${this.detectedProtocol.toUpperCase()}`,
        );
      }
    }

    // Set up TS6 HTTP Query if applicable
    if (this.detectedProtocol === "ts6") {
      const queryPort = this.options.queryPort !== 10011 ? this.options.queryPort : 10080;
      this.httpQuery = new TS6HttpQuery({
        host: this.options.host,
        port: queryPort,
        apiKey: this.options.ts6ApiKey,
      });
    }

    // Guard against calling connect() while already connected.
    // Save detectedProtocol first because disconnect() resets it.
    if (this.client) {
      this.logger.warn("connect() called while already connected, disconnecting first");
      const savedProtocol = this.detectedProtocol;
      const savedHttpQuery = this.httpQuery;
      this.disconnect();
      this.detectedProtocol = savedProtocol;
      this.httpQuery = savedHttpQuery;
      // Give the old client a moment to tear down
      await new Promise((r) => setTimeout(r, 100));
    }

    this.logger.info(
      { addr, protocol: this.detectedProtocol },
      "Connecting to TeamSpeak server (full client protocol)",
    );

    // Throttle repeated "udp send error" warnings (fires every 20ms during playback if UDP breaks)
    let udpErrorCount = 0;
    const throttledWarn = (msg: string, ...args: unknown[]) => {
      if (typeof msg === "string" && msg.includes("udp send error")) {
        udpErrorCount++;
        if (udpErrorCount === 1) {
          this.logger.warn(msg);
          // After 2 seconds, log a summary and reset.
          // Clear any previous timer to avoid leaking it.
          if (this.udpErrorTimer) clearTimeout(this.udpErrorTimer);
          this.udpErrorTimer = setTimeout(() => {
            if (udpErrorCount > 1) {
              this.logger.warn(
                `udp send error (repeated ${udpErrorCount} times, connection may be lost)`,
              );
            }
            udpErrorCount = 0;
            this.udpErrorTimer = null;
          }, 2000);
        }
        return;
      }
      this.logger.warn(msg);
    };

    this.client = new TS3FullClient(this.identity, addr, this.options.nickname, {
      // Forward server password to the protocol library so it can be
      // included in clientinit for password-protected servers
      serverPassword: this.options.serverPassword,
      logger: {
        debug: (msg) => this.logger.debug(msg),
        info: (msg) => this.logger.info(msg),
        warn: throttledWarn,
        error: (msg) => this.logger.error(msg),
      },
    });

    this.client.on("textMessage", (msg: TextMessage) => {
      const tsMsg: TS3TextMessage = {
        invokerName: msg.invokerName,
        invokerId: String(msg.invokerID),
        invokerUid: msg.invokerUID,
        invokerGroups: msg.invokerGroups,
        message: msg.message,
        targetMode: msg.targetMode,
      };
      this.emit("textMessage", tsMsg);
    });

    // Library event name is `poked` (README also says "poke").
    this.client.on("poked", (ev: PokeEvent) => {
      const poke: TS3Poke = {
        invokerName: ev.invokerName,
        invokerId: String(ev.invokerID),
        invokerUid: ev.invokerUID,
        message: ev.message ?? "",
      };
      this.emit("poke", poke);
    });

    this.client.on("disconnected", (err) => {
      this.logger.warn({ err: err?.message }, "Connection closed");
      this.clientId = 0;
      this.emit("disconnected");
    });

    // HoneyBBQ full-client presence (notifycliententerview / leftview / moved).
    this.client.on("clientEnter", (info: ClientInfo) => {
      this.logger.debug(
        { nickname: info.nickname, id: info.id, channelID: String(info.channelID) },
        "Client entered",
      );
      this.emit("clientEnter", info);
    });
    this.client.on("clientLeave", (ev: ClientLeftViewEvent) => {
      this.logger.debug({ id: ev.id, reasonID: ev.reasonID }, "Client left");
      this.emit("clientLeave", ev);
    });
    this.client.on("clientMoved", (ev: ClientMovedEvent) => {
      this.logger.debug({ id: ev.id, targetChannelID: String(ev.targetChannelID) }, "Client moved");
      this.emit("clientMoved", ev);
    });

    // Inbound voice (DESIGN §10). Attach bridge when voice pipeline is active.
    if (this.inboundVoiceConsumers > 0) {
      this.attachLibraryVoiceBridge();
    }

    await this.client.connect();
    // Note: @honeybbq/teamspeak-client 0.2.x ships a universal clientinit
    // (client_version "3.?.? [Build: 5680278000]" + matching signature)
    // that works against both TS3 and TS6 servers. The old 3.6.2 monkey-
    // patch on handler.sendPacket was removed when we bumped to 0.2.1 — it
    // would have replaced the library's new correct version with a stale
    // signature and made TS6 handshakes fail.
    await this.client.waitConnected();
    this.clientId = this.client.clientID();
    this.voiceFramesSent = 0;
    this.logger.info(
      { clientId: this.clientId, protocol: this.detectedProtocol },
      `Logged in (visible client, ${this.detectedProtocol.toUpperCase()} server)`,
    );

    // Join default channel if specified
    if (this.options.defaultChannel) {
      await this.joinChannel(this.options.defaultChannel, this.options.channelPassword);
    }

    this.emit("connected");
  }

  /** Server-group IDs for a connected client (TS6 HTTP Query fallback). */
  async getServerGroupsForClient(clid: number): Promise<string[]> {
    if (!this.httpQuery) return [];
    try {
      const sid = this.options.virtualServerId ?? 1;
      const res = await this.httpQuery.clientInfo(clid, sid);
      const row = extractQueryRows(res.body)[0];
      const raw = String(row?.client_servergroups ?? "");
      return raw
        ? raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    } catch (err) {
      this.logger.warn({ err, clid }, "Failed to load server groups for client");
      return [];
    }
  }

  /** Channel id for a connected client (TS6 HTTP Query). */
  async getClientChannelId(clid: number): Promise<bigint | null> {
    if (!this.httpQuery) return null;
    try {
      const sid = this.options.virtualServerId ?? 1;
      const res = await this.httpQuery.clientInfo(clid, sid);
      const row = extractQueryRows(res.body)[0];
      const cid = row?.cid;
      if (cid == null || cid === "") return null;
      return BigInt(String(cid));
    } catch (err) {
      this.logger.warn({ err, clid }, "Failed to load client channel");
      return null;
    }
  }

  async joinChannelById(channelId: bigint, password?: string): Promise<boolean> {
    if (!this.client) return false;
    if (this.client.channelID() === channelId) return true;
    try {
      await clientMove(this.client, this.clientId, channelId, password);
      this.logger.info({ cid: channelId.toString() }, "Joined channel by id");
      return true;
    } catch (err) {
      if (isAlreadyInChannelError(err)) {
        this.logger.debug({ cid: channelId.toString() }, "Already in target channel");
        return true;
      }
      this.logger.error({ err, cid: channelId.toString() }, "Failed to join channel by id");
      return false;
    }
  }

  async joinChannel(channelName: string, password?: string): Promise<void> {
    if (!this.client) return;

    try {
      const channels = await listChannels(this.client);
      const channel = channels.find((ch) => ch.name === channelName);

      if (!channel) {
        this.logger.warn({ channelName }, "Channel not found");
        return;
      }

      await clientMove(this.client, this.clientId, channel.id, password);
      this.logger.info({ channelName, cid: channel.id.toString() }, "Joined channel");
    } catch (err) {
      this.logger.error({ err, channelName }, "Failed to join channel");
    }
  }

  async sendTextMessage(message: string, targetMode: number = 2): Promise<void> {
    if (!this.client) return;
    // targetMode 2 = channel, target 0 = current channel
    const target = targetMode === 2 ? BigInt(0) : BigInt(this.clientId);
    await sendTextMessage(this.client, targetMode, target, message);
  }

  /**
   * Poke a client (short private nudge). Used to ack poke-commands.
   * `clid` is the invoker's numeric client id.
   */
  async pokeClient(clid: number, message: string): Promise<void> {
    if (!this.client || !Number.isFinite(clid) || clid <= 0) return;
    const text = message.length > 100 ? `${message.slice(0, 97)}…` : message;
    await tsPoke(this.client, clid, text);
  }

  /**
   * Send a channel text message to a *specific* channel id (targetMode 2). Used
   * by the file-drop watcher to confirm ingestion in the drop channel even when
   * the bot is sitting in a different (voice) channel. Best-effort: needs the
   * cross-channel text permission; failures are surfaced to the caller to log.
   */
  async sendChannelMessage(channelID: bigint, message: string): Promise<void> {
    if (!this.client) return;
    await sendTextMessage(this.client, 2, channelID, message);
  }

  async getClientsInChannel(): Promise<ClientInfo[]> {
    if (!this.client) return [];
    try {
      const allClients = await listClients(this.client);
      const myChannelId = await this.resolveOwnChannelId(allClients);
      let inChannel = filterClientsInChannel(allClients, myChannelId);
      if (inChannel.length === 0 && allClients.length > 0) {
        this.logger.warn(
          {
            allClients: allClients.length,
            myChannelId: myChannelId.toString(),
            selfClientId: this.clientId,
            sample: allClients.slice(0, 5).map((c) => ({
              id: c.id,
              cid: String(c.channelID),
              type: c.type,
              nick: c.nickname?.slice(0, 24),
            })),
          },
          "getClientsInChannel: empty after channel filter (presence may be wrong)",
        );
      }
      if (this.httpQuery && inChannel.length > 0) {
        inChannel = await this.enrichClientServerGroups(inChannel);
      }
      return inChannel;
    } catch (err) {
      this.logger.warn({ err }, "getClientsInChannel failed");
      return [];
    }
  }

  /**
   * Resolve the bot's current channel id. Prefer clientlist self-row (authoritative),
   * then the library in-memory map, then HTTP Query clientinfo. Avoids 0n when join
   * reported "already member" without updating the library map (scheduled bumper bug).
   */
  private async resolveOwnChannelId(allClients?: ClientInfo[]): Promise<bigint> {
    let httpChannelId: bigint | undefined;
    const libCid = this.client?.channelID() ?? 0n;
    // Only hit HTTP when list+library don't know us
    const fromList =
      this.clientId > 0 && allClients
        ? allClients.find((c) => c.id === this.clientId)?.channelID
        : undefined;
    if (
      (fromList == null || asChannelId(fromList) === 0n) &&
      (libCid === 0n || libCid == null) &&
      this.clientId > 0 &&
      this.httpQuery
    ) {
      httpChannelId = (await this.getClientChannelId(this.clientId)) ?? undefined;
    }
    return resolveOwnChannelIdPure({
      selfClientId: this.clientId,
      libraryChannelId: libCid,
      allClients,
      httpChannelId,
    });
  }

  /**
   * TS6 full-client `clientlist -groups` often omits `client_servergroups`; the
   * HTTP Query `clientlist?sid=N&-groups` endpoint returns them.
   */
  private async enrichClientServerGroups(clients: ClientInfo[]): Promise<ClientInfo[]> {
    const sid = this.options.virtualServerId ?? 1;
    try {
      const res = await this.httpQuery!.clientListWithGroups(sid);
      const byClid = serverGroupsByClidFromRows(extractQueryRows(res.body));
      return clients.map((c) => ({
        ...c,
        serverGroups: byClid.get(c.id) ?? c.serverGroups ?? [],
      }));
    } catch (err) {
      this.logger.warn({ err }, "Failed to enrich client server groups from HTTP query");
      return clients;
    }
  }

  // --- Raw command & file transfer pass-through ---

  async execCommand(cmd: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await this.client.execCommand(cmd);
  }

  /** Fire a command without waiting for the server's response. */
  async sendCommandNoWait(cmd: string): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await this.client.sendCommandNoWait(cmd);
  }

  async execCommandWithResponse(cmd: string): Promise<Record<string, string>[]> {
    if (!this.client) throw new Error("Not connected");
    return this.client.execCommandWithResponse(cmd);
  }

  async fileTransferInitUpload(
    channelID: bigint,
    path: string,
    password: string,
    size: bigint,
    overwrite = true,
  ): Promise<FileUploadInfo> {
    if (!this.client) throw new Error("Not connected");
    return this.client.fileTransferInitUpload(channelID, path, password, size, overwrite);
  }

  async uploadFileData(host: string, info: FileUploadInfo, data: Readable): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await this.client.uploadFileData(host, info, data);
  }

  async fileTransferDeleteFile(channelID: bigint, paths: string[]): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await fileTransferDeleteFile(this.client, channelID, paths);
  }

  async fileTransferInitDownload(
    channelID: bigint,
    path: string,
    password = "",
  ): Promise<FileDownloadInfo> {
    if (!this.client) throw new Error("Not connected");
    return this.client.fileTransferInitDownload(channelID, path, password);
  }

  async downloadFileData(host: string, info: FileDownloadInfo, dest: Writable): Promise<void> {
    if (!this.client) throw new Error("Not connected");
    await downloadFileData(host, info, dest);
  }

  /**
   * List the files in a channel's file repository, via the **TS6 HTTP Query**.
   *
   * Why not the full client: `ftgetfilelist` over the full-client protocol
   * returns its data as a `notifychannelfilelist` notification, and
   * `@honeybbq/teamspeak-client` only surfaces 8 notification types — that isn't
   * one — so `execCommandWithResponse` always came back empty (file-drop could
   * never see a dropped file). The HTTP Query returns the rows inline as JSON.
   * (Downloading still uses the full client: its `notifystartdownload` IS
   * supported.) → requires a TS6 server with the HTTP Query (an API key).
   *
   * Returns `[]` for an empty dir, a non-TS6 server, or any query failure.
   */
  async listChannelFiles(channelID: bigint, path = "/"): Promise<ChannelFile[]> {
    const q = this.httpQuery;
    if (!q) {
      this.logger.warn(
        { cid: String(channelID) },
        "listChannelFiles: TS6 HTTP Query unavailable — file-drop requires a TS6 server",
      );
      return [];
    }
    try {
      const res = await q.request(
        "GET",
        `/1/ftgetfilelist?sid=1&cid=${channelID}&cpw=&path=${encodeURIComponent(path)}`,
      );
      const files = parseFtFileList(extractFileRows(res.body));
      this.logger.debug(
        { cid: String(channelID), path, count: files.length },
        "ftgetfilelist (http query)",
      );
      return files;
    } catch (err) {
      // An empty dir / no-such-path comes back as a query error — treat as "no
      // files"; debug-level so a genuinely empty channel isn't noisy.
      this.logger.debug(
        { err, cid: String(channelID), path },
        "ftgetfilelist (http query) empty/failed",
      );
      return [];
    }
  }

  /** Resolve a channel id by exact name, or null if no such channel is visible. */
  async resolveChannelIdByName(name: string): Promise<bigint | null> {
    if (!this.client) return null;
    try {
      const channels = await listChannels(this.client);
      return channels.find((c) => c.name === name)?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Move another connected client to a channel (DESIGN §R4).
   * Prefers TS6 HTTP Query `clientmove`; falls back to the full-client API on TS3.
   * Returns a user-facing status string; never throws (errors are returned as text).
   */
  async moveClientToChannel(
    targetQuery: string,
    channelQuery: string,
    channelPassword?: string,
  ): Promise<string> {
    if (!this.client) return "Bot is not connected to TeamSpeak.";

    try {
      const httpQuery = this.httpQuery;
      if (httpQuery) {
        const [clientRes, channelRes] = await Promise.all([
          httpQuery.clientList(),
          httpQuery.channelList(),
        ]);
        const clients = parseClientRows(extractQueryRows(clientRes.body));
        const channels = parseChannelRows(extractQueryRows(channelRes.body));
        const target = resolveClientQuery(targetQuery, clients);
        if (!target.ok) return target.error;
        const channel = resolveChannelQuery(channelQuery, channels);
        if (!channel.ok) return channel.error;
        await httpQuery.clientMove(target.value.clid, channel.value.cid, channelPassword);
        return `Moved ${target.value.nickname} → ${channel.value.name}.`;
      }

      const allClients = await listClients(this.client);
      const clients = parseClientRows(
        allClients.map((c) => ({
          clid: String(c.id),
          client_nickname: c.nickname,
        })),
      );
      const target = resolveClientQuery(targetQuery, clients);
      if (!target.ok) return target.error;

      const tsChannels = await listChannels(this.client);
      const channels = parseChannelRows(
        tsChannels.map((c) => ({
          cid: String(c.id),
          channel_name: c.name,
        })),
      );
      const channel = resolveChannelQuery(channelQuery, channels);
      if (!channel.ok) return channel.error;

      await clientMove(this.client, target.value.clid, BigInt(channel.value.cid), channelPassword);
      return `Moved ${target.value.nickname} → ${channel.value.name}.`;
    } catch (err) {
      if (err instanceof HttpQueryError) {
        this.logger.warn({ err, status: err.status }, "clientmove rejected by server");
        if (err.status === 403) {
          return "Move denied — the bot needs client-move permission on the server.";
        }
        return `Move failed: ${err.message}`;
      }
      this.logger.error({ err, targetQuery, channelQuery }, "moveClientToChannel failed");
      return `Move failed: ${err instanceof Error ? err.message : "unknown error"}`;
    }
  }

  /**
   * Other clients in the bot's current channel (excludes the bot). Used for
   * mass-move confirmation (DESIGN §R4).
   */
  async listClientsInCurrentChannel(): Promise<QueryClient[]> {
    if (!this.client) return [];
    const myClid = this.clientId;

    try {
      // Prefer full-client clientlist so we can resolve our channel from self-row.
      const allClients = await listClients(this.client);
      const myChannelId = await this.resolveOwnChannelId(allClients);
      const myCidNum = Number(myChannelId);

      const httpQuery = this.httpQuery;
      if (httpQuery && myCidNum > 0) {
        const res = await httpQuery.clientList();
        const rows = extractQueryRows(res.body);
        const out: QueryClient[] = [];
        for (const row of rows) {
          const clid = Number.parseInt(String(row.clid ?? ""), 10);
          const cid = Number.parseInt(String(row.cid ?? ""), 10);
          const nickname = String(row.client_nickname ?? row.nickname ?? "").trim();
          if (!Number.isFinite(clid) || !Number.isFinite(cid) || !nickname) continue;
          if (cid !== myCidNum || clid === myClid) continue;
          out.push({ clid, nickname });
        }
        if (out.length > 0 || myCidNum > 0) return out;
      }

      return parseClientRows(
        filterClientsInChannel(allClients, myChannelId)
          .filter((c) => c.id !== myClid)
          .map((c) => ({ clid: String(c.id), client_nickname: c.nickname })),
      );
    } catch (err) {
      this.logger.warn({ err }, "listClientsInCurrentChannel failed");
      return [];
    }
  }

  /** The server host (needed for file transfer TCP connections). */
  getHost(): string {
    return this.options.host;
  }

  /** The current channel ID of this client. */
  getChannelId(): bigint {
    if (!this.client) return 0n;
    return this.client.channelID();
  }

  private voiceFramesSent = 0;

  sendVoiceData(opusFrame: Buffer): void {
    if (!this.client || this.disconnecting) return;
    try {
      this.client.sendVoice(opusFrame, 5);
      this.voiceFramesSent++;
      this.voiceTransportHealth.noteSuccess();
      if (this.voiceFramesSent === 1) {
        this.logger.info(
          { opusBytes: opusFrame.length, clientId: this.clientId },
          "First voice packet sent to TeamSpeak",
        );
      }
    } catch (err) {
      if (this.voiceFramesSent === 0) {
        this.logger.error({ err }, "Failed to send first voice packet");
      } else {
        this.logger.warn({ err }, "sendVoice failed");
      }
      // S-OC2: transport/session send failures only (not Opus decode).
      if (this.voiceTransportHealth.noteError()) {
        this.logger.warn("Voice transport unhealthy — requesting reconnect");
        this.emit("voiceTransportUnhealthy");
      }
    }
  }

  /** After a reconnect cycle so the threshold can fire again. */
  resetVoiceTransportHealth(): void {
    this.voiceTransportHealth.clearRecoveryLatch();
  }

  /** M-REL-2: apply operator knobs from config.reconnect.voiceError*. */
  configureVoiceTransportHealth(opts: {
    threshold?: number;
    windowMs?: number;
    healthyReset?: number;
  }): void {
    this.voiceTransportHealth = new VoiceTransportHealth(opts);
  }

  getIdentityExport(): string {
    return this.identity.toString();
  }

  getClientId(): number {
    return this.clientId;
  }

  disconnect(): void {
    this.libraryVoiceBridge = null;
    this.inboundVoicePackets = 0;
    if (this.client && !this.disconnecting) {
      this.disconnecting = true;
      const client = this.client;
      client
        .disconnect()
        .catch(() => {})
        .finally(() => {
          if (this.client === client) {
            this.client = null;
          }
          this.disconnecting = false;
        });
    }
    this.clientId = 0;
    this.httpQuery = null;
    this.detectedProtocol = "unknown";
    if (this.udpErrorTimer) {
      clearTimeout(this.udpErrorTimer);
      this.udpErrorTimer = null;
    }
    this.logger.info("Disconnected from TeamSpeak server");
  }
}
