import { EventEmitter } from "node:events";
import {
  TS3Client,
  type TS3ClientOptions,
  type TS3TextMessage,
} from "../ts-protocol/client.js";
import { AudioPlayer } from "../audio/player.js";
import { PlayQueue, PlayMode, type QueuedSong } from "../audio/queue.js";
import type { MusicProvider, Song } from "../music/provider.js";
import {
  parseCommand,
  type ParsedCommand,
} from "./commands.js";
import type { Logger } from "../logger.js";
import type { BotDatabase, ProfileConfig } from "../data/database.js";
import type { BotConfig } from "../data/config.js";
import { BotProfileManager } from "./profile.js";
import type { AvatarStore } from "../data/avatars.js";
import { RoastStore } from "../data/roast.js";
import { ControlRouter, type RouterContext, type LlmAssist } from "../control/router.js";
import { LlmModule, LlmClient } from "../llm/index.js";
import { RightsEngine, defaultRightsConfig, type Subject, type RightsConfig } from "../rights/index.js";
import {
  VoicePipeline,
  SilenceSegmenter,
  SherpaSttClient,
  KokoroTtsClient,
  type SttProvider,
  type TtsProvider,
  type VoiceOutput,
  type Utterance,
} from "../voice/index.js";
import { createOpusEncoder, type Encoder } from "../audio/encoder.js";
import type { TS3VoiceData } from "../ts-protocol/client.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DEMO_VIDEO_URL } from "../music/youtube.js";

/**
 * Stable conversation key for LLM history (DESIGN §9). Private messages are
 * scoped per-user; channel/server chat shares one key since the bot sits in a
 * single channel. (targetMode: 1=private, 2=channel, 3=server.)
 */
function conversationKey(msg: TS3TextMessage): string {
  return msg.targetMode === 1 ? `dm:${msg.invokerUid}` : "channel";
}

/**
 * Parse the roast grader's reply into a score + reason. The model is asked for
 * strict JSON but small local models stray, so we extract the first {...} block
 * and tolerate junk around it. RoastStore.setGrade clamps the score to 0–10.
 * Returns null when no usable object is found (caller marks it ungradeable).
 */
function parseRoastGrade(raw: string): { score: number; reason: string } | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { score?: unknown; reason?: unknown };
    const score = Number(o.score);
    if (!Number.isFinite(score)) return null;
    return { score, reason: String(o.reason ?? "").slice(0, 280) };
  } catch {
    return null;
  }
}

export interface BotInstanceOptions {
  id: string;
  name: string;
  tsOptions: TS3ClientOptions;
  localProvider: MusicProvider;
  youtubeProvider: MusicProvider;
  streamProvider: MusicProvider;
  database: BotDatabase;
  config: BotConfig;
  logger: Logger;
  avatarStore: AvatarStore;
}

export interface BotStatus {
  id: string;
  name: string;
  connected: boolean;
  playing: boolean;
  paused: boolean;
  currentSong: QueuedSong | null;
  queueSize: number;
  volume: number;
  playMode: PlayMode;
  elapsed: number; // ground truth elapsed seconds from frame count
}

export class BotInstance extends EventEmitter {
  readonly id: string;
  name: string;

  private tsClient: TS3Client;
  private player: AudioPlayer;
  private queue: PlayQueue;
  private localProvider: MusicProvider;
  private youtubeProvider: MusicProvider;
  private streamProvider: MusicProvider;
  private database: BotDatabase;
  private config: BotConfig;
  private logger: Logger;
  private avatarStore: AvatarStore;
  private roastStore: RoastStore;
  private lastRoastAt = 0;
  private roastCompiling = false;
  private connected = false;
  private disconnectEmitted = false;
  private voteSkipUsers = new Set<string>();
  private isAdvancing = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private channelUserCount = 0;
  private profileManager: BotProfileManager;
  private controlRouter: ControlRouter;
  private rightsEngine: RightsEngine | null = null;
  private llmModule: LlmModule | null = null;
  // Voice pipeline (DESIGN §10) — all null unless config.voice.enabled.
  private voicePipeline: VoicePipeline | null = null;
  private voiceDecoder: Encoder | null = null;
  private voiceSegmenters = new Map<number, SilenceSegmenter>();
  private voiceTempDir: string | null = null;
  private savedMusicForVoice: { song: QueuedSong; elapsed: number } | null = null;
  /** clientId → {uid, serverGroups} cache for voice rank gating (refreshed by the idle poller). */
  private clientInfoCache = new Map<number, { uid: string; serverGroups: string[]; nickname: string }>();

  constructor(options: BotInstanceOptions) {
    super();
    this.id = options.id;
    this.name = options.name;
    this.localProvider = options.localProvider;
    this.youtubeProvider = options.youtubeProvider;
    this.streamProvider = options.streamProvider;
    this.database = options.database;
    this.config = options.config;
    this.logger = options.logger.child({ botId: this.id });
    this.avatarStore = options.avatarStore;
    this.roastStore = new RoastStore(this.database.db);

    this.tsClient = new TS3Client(options.tsOptions, this.logger);
    this.player = new AudioPlayer(this.logger);
    this.queue = new PlayQueue();

    const profileConfig = this.database.getProfileConfig(this.id);
    this.profileManager = new BotProfileManager(
      this.tsClient,
      this.logger,
      profileConfig,
      options.tsOptions.nickname,
    );

    // Wire the in-process LLM module when enabled (DESIGN §9). Gated by config
    // so an absent/down RKLLama never stalls command handling on a request
    // timeout — `!ask` and fuzzy intent simply report "not configured" instead.
    if (this.config.llmEnabled) {
      this.llmModule = new LlmModule({
        logger: this.logger,
        systemPrompt: this.config.llmSystemPrompt || undefined,
        temperature: this.config.llmTemperature,
        client: new LlmClient({
          baseUrl: this.config.llmUrl || undefined,
          model: this.config.llmModel || undefined,
          logger: this.logger,
        }),
      });
      this.logger.info("LLM module enabled (RKLLama)");
    }

    this.controlRouter = new ControlRouter(this.logger, this.llmModule ?? undefined);

    // Rank gating (DESIGN §8). Use an explicit ruleset if provided, else derive
    // a default from adminGroups. Default ON / fail-safe (audit F-4): a missing
    // flag (older config) is treated as enabled so privileged + LLM-driven
    // actions are never ungated by accident. Only an explicit false opts out.
    if (this.config.rightsEnabled ?? true) {
      this.rightsEngine = new RightsEngine(this.config.rights ?? defaultRightsConfig(this.config.adminGroups));
      this.logger.info("Rank gating enabled");
    }

    // Voice pipeline (DESIGN §10). Gated off by default; needs sidecars + real
    // hardware to validate the inbound-capture path.
    if (this.config.voice?.enabled) {
      this.setupVoice();
    }

    // Register command handlers with the router (gradual migration path)
    this.registerCoreCommandHandlers();

    // Best-effort: a corrupted/locked avatar file must not block bot startup.
    try {
      const relPath = this.database.getCustomAvatarPath(this.id);
      if (relPath) {
        const buf = this.avatarStore.read(relPath);
        if (buf) this.profileManager.setCustomAvatar(buf);
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to load custom avatar — skipping");
    }

    this.setupPlayerEvents();
    this.setupTsEvents();
  }

  private setupPlayerEvents(): void {
    this.player.on("frame", (opusFrame: Buffer) => {
      this.tsClient.sendVoiceData(opusFrame);
    });

    this.player.on("trackEnd", () => {
      if (this.savedMusicForVoice) {
        const saved = this.savedMusicForVoice;
        this.savedMusicForVoice = null;
        this.logger.debug("Voice reply ended — attempting to resume previous music (ducking/resume)");

        (async () => {
          // Race guard: if queue changed during voice (e.g. user skip/clear), don't blindly resume.
          const current = this.queue.current();
          if (!current || current.id !== saved.song.id) {
            this.logger.debug("Queue changed during voice reply; skipping music resume");
            this.playNext().catch((err) => {
              this.logger.error({ err }, "playNext failed after voice (queue changed)");
            });
            return;
          }
          try {
            const provider = this.getProviderFor(saved.song.platform);
            const url = await provider.getSongUrl(saved.song.id);
            if (url && this.connected) {
              this.player.resetFailures();
              this.player.play(url, saved.elapsed, saved.song.duration || 0);
              return;
            }
          } catch (e) {
            this.logger.warn({ err: e }, "Failed to resume interrupted music after voice");
          }
          // fallback
          this.playNext().catch((err) => {
            this.logger.error({ err }, "playNext failed after voice resume fallback");
          });
        })();
        return;
      }

      this.logger.debug("Track ended, advancing queue");
      this.playNext().catch((err) => {
        this.logger.error({ err }, "playNext failed after trackEnd");
      });
    });

    this.player.on("error", (err: Error) => {
      if (this.savedMusicForVoice) {
        this.savedMusicForVoice = null;
      }
      this.logger.error({ err }, "Player error");
      this.playNext().catch((err2) => {
        this.logger.error({ err: err2 }, "playNext failed after player error");
      });
    });
  }

  private setupTsEvents(): void {
    this.tsClient.on("textMessage", (msg: TS3TextMessage) => {
      this.handleTextMessage(msg).catch((err) => {
        this.logger.error({ err }, "Unhandled error in text message handler");
      });
    });

    this.tsClient.on("disconnected", () => {
      // Always reset local state — covers the case where connect() never
      // completed (hanging handshake → 60s library idle timeout) and
      // this.connected was never flipped to true. Previously this handler
      // short-circuited on !this.connected, leaving player stuck as "playing".
      this.connected = false;
      this.player.stop();
      this.cleanupVoice();
      this.savedMusicForVoice = null;
      // Only emit externally once per lifecycle so clients don't see a
      // duplicate "disconnected" after an explicit disconnect() call.
      if (this.disconnectEmitted) return;
      this.disconnectEmitted = true;
      this.emit("disconnected");
    });

    this.tsClient.on("connected", () => {
      this._startIdlePoller();
    });
  }

  async connect(): Promise<void> {
    this.disconnectEmitted = false;
    await this.tsClient.connect();
    // Race guard: if disconnect() was called while the handshake was
    // awaiting, don't flip connected back to true — that would leave the
    // bot in an inconsistent state (externally "connected" but the tsClient
    // has already been torn down).
    if (this.disconnectEmitted) {
      throw new Error("Connect aborted by concurrent disconnect");
    }
    this.connected = true;
    this.profileManager.onConnect();
    this.emit("connected");

    // Default demo / unit test video (https://www.youtube.com/watch?v=hLOheGDwD_0) for easy Phase 0 startup validation.
    // Override or disable (empty) with PHASE0_TEST_PLAY. Auto-play only triggers in Phase 0 contexts
    // (TS6_* vars present or PHASE0_TEST_PLAY explicitly set) so normal bots don't auto-queue a demo track.
    const envTrack = process.env.PHASE0_TEST_PLAY;
    const isPhase0 = !!envTrack || !!process.env.TS6_HOST || !!process.env.TS_HOST;
    const testTrack = (envTrack != null && envTrack.trim() !== "") ? envTrack : DEFAULT_DEMO_VIDEO_URL;

    if (isPhase0) {
      this.logger.info("═══════════════════════════════════════════════════════════════");
      this.logger.info("PHASE 0: Bot successfully connected to TeamSpeak server!");
      this.logger.info(`PHASE 0: Will auto-attempt playback of: ${testTrack} (default unit test / startup track)`);
      this.logger.info("═══════════════════════════════════════════════════════════════");

      // Auto-play shortly after connect. This is the "default start up" behavior for validation.
      setTimeout(async () => {
        this.logger.info({ track: testTrack }, "Phase 0: Attempting automatic test playback");
        try {
          const flags = new Set<string>();
          if (!testTrack.startsWith('http')) flags.add('l');
          const result = await this.cmdPlay({ name: 'play', args: testTrack, rawArgs: [testTrack], flags } as any);
          this.logger.info({ track: testTrack, result }, "Phase 0: Test playback command executed");

          // Loud success banner for Phase 0 validation
          if (typeof result === 'string' && result.toLowerCase().includes('now playing')) {
            this.logger.info("═══════════════════════════════════════════════════════════════");
            this.logger.info("PHASE 0 SUCCESS: Bot connected and test audio playback initiated!");
            this.logger.info(`Test track: ${testTrack}`);
            this.logger.info("Check your TeamSpeak channel — you should hear audio now.");
            this.logger.info("═══════════════════════════════════════════════════════════════");
          } else {
            this.logger.warn({ result }, "Phase 0 auto-play did not report success");
          }
        } catch (e) {
          this.logger.error({ err: e, track: testTrack }, "Phase 0: Test playback failed");
        }
      }, 4000);
    }
  }

  disconnect(): void {
    this._cancelIdleTimer();
    this.player.stop();
    this.cleanupVoice();
    this.savedMusicForVoice = null;
    this.clientInfoCache.clear();
    this.connected = false;
    if (!this.disconnectEmitted) {
      this.disconnectEmitted = true;
      this.emit("disconnected");
    }
    this.tsClient.disconnect();
  }

  /** External update for idleTimeoutMinutes (called when saved via API) */
  updateIdleTimeout(minutes: number): void {
    this.config.idleTimeoutMinutes = minutes;
    if (minutes === 0) this._cancelIdleTimer();
  }

  private _startIdlePoller(): void {
    // Check channel user count every 30s
    const poll = async () => {
      if (!this.connected) return;
      try {
        const clients = await this.tsClient.getClientsInChannel();
        // Refresh the clientId→groups cache used for voice rank gating.
        if (this.voicePipeline) {
          this.clientInfoCache.clear();
          for (const c of clients) {
            this.clientInfoCache.set(c.id, { uid: c.uid, serverGroups: c.serverGroups ?? [], nickname: c.nickname });
          }
        }
        const userCount = clients.length - 1; // exclude the bot itself
        if (userCount <= 0) {
          this._scheduleIdleCheck();
        } else {
          this._cancelIdleTimer();
        }
        // Roast (Phase 8): grade captured lines + maybe drop a compilation.
        // Fire-and-forget — its own guard serializes slow NPU grading.
        if (this.config.roastEnabled) {
          this.runRoastTick(userCount).catch(() => {});
        }
      } catch { /* ignore */ }
      setTimeout(poll, 30_000);
    };
    setTimeout(poll, 30_000);
  }

  private _scheduleIdleCheck(): void {
    if (this.idleTimer !== null) return; // already counting down, do not recreate
    const minutes = this.config.idleTimeoutMinutes ?? 0;
    if (!this.connected || minutes <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (!this.connected) return;
      this.logger.info({ idleMinutes: minutes }, "Channel empty, disconnecting due to idle timeout");
      this.disconnect();
    }, minutes * 60 * 1000);
  }

  private _cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // === Voice pipeline (DESIGN §10) ===

  /** Build the STT/TTS providers + pipeline and subscribe to inbound voice. */
  private setupVoice(): void {
    const vc = this.config.voice;
    if (!vc.sttUrl) {
      this.logger.warn("Voice enabled but no sttUrl configured — voice loop inactive");
      return;
    }
    const stt: SttProvider = new SherpaSttClient({ url: vc.sttUrl, logger: this.logger });
    const tts: TtsProvider | undefined = vc.ttsUrl
      ? new KokoroTtsClient({ url: vc.ttsUrl, voice: vc.ttsVoice, logger: this.logger })
      : undefined;
    const output: VoiceOutput | undefined = tts ? this.createVoiceOutput() : undefined;

    this.voiceDecoder = createOpusEncoder();
    this.voicePipeline = new VoicePipeline({
      router: this.controlRouter,
      stt,
      tts,
      output,
      respondWithVoice: vc.respondWithVoice && !!output,
      aliases: this.config.commandAliases,
      logger: this.logger,
      buildContext: (u) => this.buildVoiceContext(u),
      onTurn: ({ transcript, reply, speakerUid }) =>
        this.logger.info({ transcript, reply, speakerUid }, "Voice turn"),
    });

    // Ensure any previous temp dir is cleaned if voice is re-enabled on same instance
    this.cleanupVoice();

    this.tsClient.on("voiceData", (v: TS3VoiceData) => this.handleVoiceData(v));
    this.logger.info({ stt: true, tts: !!tts }, "Voice pipeline enabled");
  }

  /** Decode an inbound Opus packet, end-point per speaker, dispatch utterances. */
  private handleVoiceData(v: TS3VoiceData): void {
    if (!this.voicePipeline || !this.voiceDecoder) return;
    let pcm: Buffer;
    try {
      pcm = this.voiceDecoder.decode(v.data);
    } catch (err) {
      this.logger.debug({ err, clientId: v.clientId }, "Voice: opus decode failed");
      return;
    }
    let seg = this.voiceSegmenters.get(v.clientId);
    if (!seg) {
      // Decoder emits 48 kHz stereo PCM (see audio/encoder.ts).
      seg = new SilenceSegmenter({ sampleRate: 48_000, channels: 2 });
      this.voiceSegmenters.set(v.clientId, seg);
    }
    const utterancePcm = seg.push(pcm);
    if (!utterancePcm) return;

    const channels = 2;
    const durationMs = (utterancePcm.length / 2 / channels / 48_000) * 1000;
    const utterance: Utterance = {
      speakerClientId: v.clientId,
      speakerUid: this.clientInfoCache.get(v.clientId)?.uid,
      pcm: utterancePcm,
      sampleRate: 48_000,
      channels,
      durationMs,
    };
    this.voicePipeline.handleUtterance(utterance).catch((err) =>
      this.logger.warn({ err }, "Voice: handleUtterance failed"),
    );
  }

  /** Routing context for a voice turn — speaker subject (rank gating) + per-speaker history. */
  private async buildVoiceContext(u: Utterance): Promise<RouterContext> {
    const subject = await this.resolveVoiceSubject(u.speakerClientId);
    u.speakerUid = subject.uid;
    const engine = this.rightsEngine;
    const canRun = engine ? (cmd: string) => engine.can(subject, cmd) : undefined;
    return {
      bot: this,
      logger: this.logger,
      conversationId: `voice:${subject.uid}`,
      canRun,
      invokerUid: subject.uid,
      invokerName: subject.nickname,
    };
  }

  /**
   * Resolve a speaking client's rights subject LIVE at utterance time (audit
   * F-5). The `clientInfoCache` is keyed on the TS numeric client id, which is
   * reused across reconnects — trusting it for a rank decision risks granting a
   * new occupant a previous client's groups (or worse, UID-matched rules). So
   * we re-query the channel by client id and ignore the cache for rank. On any
   * miss/error we return a synthetic UID with no groups: lowest privilege, and
   * a UID that can't match a real rights rule.
   */
  private async resolveVoiceSubject(clid: number): Promise<Subject> {
    try {
      const clients = await this.tsClient.getClientsInChannel();
      const c = clients.find((cl) => cl.id === clid);
      if (c) return { uid: c.uid, serverGroups: c.serverGroups ?? [], nickname: c.nickname };
    } catch (err) {
      this.logger.warn({ err, clid }, "Voice: live subject resolution failed — defaulting to lowest privilege");
    }
    return { uid: `client:${clid}`, serverGroups: [] };
  }

  /** Play a synthesized reply through the same AudioPlayer (interrupts music). */
  private createVoiceOutput(): VoiceOutput {
    return {
      speak: async (audio: Buffer, format: string) => {
        if (!this.connected) return;
        if (!this.voiceTempDir) this.voiceTempDir = mkdtempSync(join(tmpdir(), "moneypenny-tts-"));
        const file = join(this.voiceTempDir, `reply.${format}`);
        writeFileSync(file, audio);

        // Save music state so we can resume after the voice reply (implements
        // "ducking + resume" polish item from DESIGN.md §10 / Phase 3).
        // Currently voice play interrupts the music track; we resume the
        // previous song from the saved position after the voice track ends.
        const currentSong = this.queue.current();
        if (currentSong) {
          const elapsed = Math.floor(this.player?.getElapsed?.() ?? 0);
          this.savedMusicForVoice = { song: currentSong, elapsed };
        }

        // ffmpeg decodes whatever container Kokoro returned. NOTE: this stops
        // current music; ducking + resume is a polish item (Phase 3).
        this.player.resetFailures();
        this.player.play(file);
        // Best-effort cleanup of the reply file shortly after playback starts
        // (player may have its own temp handling; this reduces accumulation).
        setTimeout(() => {
          try { rmSync(file, { force: true }); } catch {}
        }, 3000);
      },
    };
  }

  /** Clean up per-speaker VAD segmenters and the TTS temp directory to prevent leaks. */
  private cleanupVoice(): void {
    this.voiceSegmenters.clear();
    if (this.voiceTempDir) {
      try {
        rmSync(this.voiceTempDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
      this.voiceTempDir = null;
    }
  }

  /**
   * Resolve the acting user's rights subject by matching their UID against the
   * clients currently in the bot's channel (ClientInfo carries serverGroups).
   * Falls back to an empty group list (lowest privilege) if the lookup fails or
   * the user isn't visible — never grants access on error.
   */
  private async resolveSubject(uid: string): Promise<Subject> {
    try {
      const clients = await this.tsClient.getClientsInChannel();
      const me = clients.find((c) => c.uid === uid);
      if (me) return { uid, serverGroups: me.serverGroups ?? [], nickname: me.nickname };
    } catch (err) {
      this.logger.warn({ err, uid }, "Failed to resolve rights subject — defaulting to lowest privilege");
    }
    return { uid, serverGroups: [] };
  }

  /**
   * Enable/disable or reconfigure the in-process LLM at runtime (DESIGN §9),
   * without a bot restart. Rebuilds the module + client and swaps it on the
   * router. Disabling detaches it (router falls back to "not configured").
   * Note: rebuilding drops in-memory conversation history.
   */
  updateLlm(
    enabled: boolean,
    url?: string,
    model?: string,
    systemPrompt?: string,
    temperature?: number,
  ): void {
    this.config.llmEnabled = enabled;
    this.config.llmUrl = url ?? "";
    this.config.llmModel = model ?? "";
    if (systemPrompt !== undefined) this.config.llmSystemPrompt = systemPrompt;
    if (temperature !== undefined) this.config.llmTemperature = temperature;
    if (!enabled) {
      this.llmModule = null;
      this.controlRouter.setLlm(undefined);
      return;
    }
    this.llmModule = new LlmModule({
      logger: this.logger,
      client: new LlmClient({
        baseUrl: this.config.llmUrl || undefined,
        model: this.config.llmModel || undefined,
        logger: this.logger,
      }),
    });
    this.controlRouter.setLlm(this.llmModule);
  }

  /** LLM status for the web UI: whether it's configured and reachable. */
  async getLlmStatus(): Promise<{ configured: boolean; available: boolean }> {
    if (!this.llmModule) return { configured: false, available: false };
    return { configured: true, available: await this.llmModule.isAvailable() };
  }

  /** One-shot Q&A for the web UI's test box. Null when the LLM is disabled. */
  async askLlm(question: string): Promise<string | null> {
    if (!this.llmModule) return null;
    return this.llmModule.ask(question);
  }

  /**
   * Hot-reload the rank-gating ruleset without a restart (DESIGN §8). Pass a
   * RightsConfig to swap rules, or undefined to rebuild the adminGroups-derived
   * default. Enables/disables the engine to match `enabled`.
   */
  updateRights(enabled: boolean, rights?: RightsConfig): void {
    this.config.rightsEnabled = enabled;
    this.config.rights = rights;
    if (!enabled) {
      this.rightsEngine = null;
      return;
    }
    const cfg = rights ?? defaultRightsConfig(this.config.adminGroups);
    if (this.rightsEngine) this.rightsEngine.reload(cfg);
    else this.rightsEngine = new RightsEngine(cfg);
  }

  /**
   * Live-update the roast/community settings (ROADMAP Phase 8) without a restart.
   * The grader and compiler read {@link config} on every poll tick, so mutating
   * it here is enough — no module to rebuild. The RoastStore (and its captured
   * data) persists across an enable/disable toggle.
   */
  updateRoast(enabled: boolean, minPresent?: number, cooldownMinutes?: number): void {
    this.config.roastEnabled = enabled;
    if (minPresent !== undefined) this.config.roastMinPresent = minPresent;
    if (cooldownMinutes !== undefined) this.config.roastCooldownMinutes = cooldownMinutes;
  }

  private async handleTextMessage(msg: TS3TextMessage): Promise<void> {
    // Roast capture (ROADMAP Phase 8): record ordinary chat lines so the grader
    // has material. Done before routing so even command-bearing turns are seen
    // (the capture itself filters commands out).
    this.captureRoastLine(msg);

    // Resolve rank gating up front (DESIGN §8): look up the invoker's
    // server-groups so the router can gate both typed and LLM-driven commands.
    let canRun: ((commandName: string) => boolean) | undefined;
    if (this.rightsEngine) {
      const subject = await this.resolveSubject(msg.invokerUid);
      const engine = this.rightsEngine;
      canRun = (commandName: string) => engine.can(subject, commandName);
    }

    const context: RouterContext = {
      bot: this,
      logger: this.logger,
      conversationId: conversationKey(msg),
      canRun,
      invokerUid: msg.invokerUid,
      invokerName: msg.invokerName,
    };

    const decision = await this.controlRouter.route(
      msg.message,
      context,
      this.config.commandPrefix,
      this.config.commandAliases
    );

    try {
      const response = await this.controlRouter.execute(decision, context);

      if (response) {
        await this.tsClient.sendTextMessage(response);
      } else if (decision.type === "deterministic" && decision.command) {
        // Router should handle everything now. This is a safety net.
        this.logger.warn({ command: decision.command.name }, "Router returned no response — command may be incomplete in new system");
        // Do NOT fall back anymore for normal commands to force completion of the router.
      }
    } catch (err) {
      this.logger.error({ err, decision }, "ControlRouter error");
      try {
        await this.tsClient.sendTextMessage(`Error: ${(err as Error).message}`);
      } catch {}
    }
  }

  async executeCommand(
    cmd: ParsedCommand,
    msg?: TS3TextMessage
  ): Promise<string | null> {
    // Reject commands that would push audio when the bot isn't connected:
    // otherwise ffmpeg spawns and voice goes to a half-initialized or
    // torn-down TS client, leaving player.state="playing" on a disconnected
    // bot. Config-only commands (vol, mode, clear, stop, queue, now) are
    // still allowed so the UI stays usable while the bot is offline.
    const AUDIO_COMMANDS = new Set([
      "play",
      "add",
      "playnext",
      "pn",
      "next",
      "skip",
      "prev",
      "playlist",
      "album",
      "fm",
      "artist",
    ]);
    if (!this.connected && AUDIO_COMMANDS.has(cmd.name)) {
      throw new Error("Bot is not connected to TeamSpeak");
    }
    switch (cmd.name) {
      case "play":
        return this.cmdPlay(cmd);
      case "add":
        return this.cmdAdd(cmd);
      case "playnext":
      case "pn":
        return this.cmdPlayNext(cmd);
      case "pause":
        return this.cmdPause();
      case "resume":
        return this.cmdResume();
      case "stop":
        return this.cmdStop();
      case "next":
      case "skip":
        return this.cmdNext();
      case "prev":
        return this.cmdPrev();
      case "vol":
        return this.cmdVol(cmd);
      case "now":
        return this.cmdNow();
      case "queue":
      case "list":
        return this.cmdQueue();
      case "clear":
        return this.cmdClear();
      case "remove":
        return this.cmdRemove(cmd);
      case "mode":
        return this.cmdMode(cmd);
      case "playlist":
        return this.cmdPlaylist(cmd);
      case "album":
        return this.cmdAlbum(cmd);
      case "fm":
        return this.cmdFm();
      case "artist":
        return this.cmdArtist(cmd);
      case "vote":
        return this.cmdVote(msg);
      case "lyrics":
        return this.cmdLyrics();
      case "move":
        return this.cmdMove(cmd);
      case "follow":
        return this.cmdFollow(msg);
      case "help":
        return this.cmdHelp();
      case "test":
        return this.cmdTest();
      default:
        return `Unknown command: ${cmd.name}. Type ${this.config.commandPrefix}help for help.`;
    }
  }

  getProviderFor(platform: "local" | "youtube" | "stream"): MusicProvider {
    if (platform === "local") return this.localProvider;
    if (platform === "youtube") return this.youtubeProvider;
    if (platform === "stream") return this.streamProvider;
    return this.localProvider;
  }

  // === Clean public API for ControlRouter (and future rights/LLM modules) ===

  isConnected(): boolean {
    return this.connected;
  }

  getCurrentQueue(): QueuedSong[] {
    return this.queue.list ? this.queue.list() : [];
  }

  private getProvider(flags: Set<string>, query?: string): MusicProvider {
    if (flags.has("l")) return this.localProvider;
    if (flags.has("y")) return this.youtubeProvider;
    if (flags.has("s")) return this.streamProvider;
    // Auto-route a recognizable stream/Spotify reference to the StreamProvider
    // (DESIGN §7.4 unified resolution) — a non-YouTube http(s) URL or a bridged
    // Spotify ref. Everything else defaults to Local (primary source).
    if (query) {
      const yp = this.youtubeProvider as unknown as { canHandle?: (q: string) => boolean };
      if (yp.canHandle?.(query)) return this.youtubeProvider;
      const sp = this.streamProvider as unknown as { canHandle?: (q: string) => boolean };
      if (sp.canHandle?.(query)) return this.streamProvider;
    }
    return this.localProvider;
  }

  /**
   * Resolve the first search hit for a play/add command. Picks the provider via
   * {@link getProvider} (honoring -l/-y/-s flags and URL auto-routing). If that
   * fell back to Local (no explicit provider flag) and found nothing — e.g. an
   * empty local library — transparently retry on YouTube so a bare
   * `!play <terms>` works without forcing the -y flag. Returns the matched song
   * together with the provider that actually produced it (its platform must be
   * used when enqueuing), or null if nothing was found anywhere.
   */
  private async searchFirst(
    cmd: ParsedCommand,
    limit = 1,
  ): Promise<{ provider: MusicProvider; song: Song } | null> {
    const provider = this.getProvider(cmd.flags, cmd.args);
    let result = await provider.search(cmd.args, limit);
    let chosen = provider;
    if (
      result.songs.length === 0 &&
      provider === this.localProvider &&
      !cmd.flags.has("l")
    ) {
      const yt = await this.youtubeProvider.search(cmd.args, limit);
      if (yt.songs.length > 0) {
        result = yt;
        chosen = this.youtubeProvider;
      }
    }
    if (result.songs.length === 0) return null;
    return { provider: chosen, song: result.songs[0] };
  }

  private registerCoreCommandHandlers() {
    // === Core music commands (router prefers resolved local when available) ===
    const resolvedMusicCommands = ['play', 'add', 'playnext', 'pn', 'playlist', 'album'];

    resolvedMusicCommands.forEach(name => {
      this.controlRouter.registerHandler({
        name,
        execute: async (cmd, ctx, decision) => {
          if (decision.resolvedMusic) {
            if (name === 'add') {
              return this.addResolvedItem(decision.resolvedMusic, decision.resolvedMusic.providerPlatform);
            }
            return this.playResolvedItem(decision.resolvedMusic, decision.resolvedMusic.providerPlatform);
          }
          // Fallback for YouTube / Stream when no strong local resolve
          return this.executeCommand(cmd);
        }
      });
    });

    // === Direct transport commands using low-level router methods ===
    this.controlRouter.registerHandler({
      name: 'skip',
      execute: async () => { await this.skipNext(); return "Skipped to next."; }
    });
    this.controlRouter.registerHandler({
      name: 'next',
      execute: async () => { await this.skipNext(); return "Skipped to next."; }
    });
    this.controlRouter.registerHandler({
      name: 'pause',
      execute: async () => { this.pausePlayback(); return "Playback paused."; }
    });
    this.controlRouter.registerHandler({
      name: 'resume',
      execute: async () => { this.resumePlayback(); return "Playback resumed."; }
    });
    this.controlRouter.registerHandler({
      name: 'stop',
      execute: async () => { this.clearQueueAndStop(); return "Stopped and cleared queue."; }
    });

    // === Simple management (direct where possible) ===
    this.controlRouter.registerHandler({
      name: 'clear',
      execute: async () => { this.clearQueueAndStop(); return "Queue cleared."; }
    });
    this.controlRouter.registerHandler({
      name: 'vol',
      execute: async (cmd) => {
        const vol = parseInt(cmd.args);
        if (isNaN(vol)) return "Usage: !vol 0-100";
        this.setVolume(vol);
        return `Volume set to ${vol}%`;
      }
    });
    this.controlRouter.registerHandler({
      name: 'remove',
      execute: async (cmd) => {
        const index = parseInt(cmd.args, 10) - 1;
        if (isNaN(index) || index < 0) return "Usage: !remove <number>";
        const removed = this.queue.remove(index);
        if (!removed) return "Invalid position";
        this.emit("stateChange");
        return `Removed: ${removed.name}`;
      }
    });
    this.controlRouter.registerHandler({
      name: 'mode',
      execute: async (cmd) => {
        const mode = cmd.args.toLowerCase();
        const modeMap: Record<string, PlayMode> = {
          seq: PlayMode.Sequential,
          sequential: PlayMode.Sequential,
          loop: PlayMode.Loop,
          random: PlayMode.Random,
          rand: PlayMode.Random,
          rloop: PlayMode.RandomLoop,
          'random-loop': PlayMode.RandomLoop,
        };
        const newMode = modeMap[mode];
        if (!newMode) return "Usage: !mode seq|loop|random|rloop";
        this.queue.setMode(newMode);
        this.emit("stateChange");
        return `Mode set to ${newMode}`;
      }
    });

    // === Info commands (direct implementations) ===
    this.controlRouter.registerHandler({
      name: 'now',
      execute: async () => {
        const song = this.queue.current();
        if (!song) return "Nothing is playing";
        return `Now playing: ${song.name} - ${song.artist} [${song.album}] (${song.platform})`;
      }
    });
    this.controlRouter.registerHandler({
      name: 'queue',
      execute: async () => {
        const songs = this.queue.list();
        if (songs.length === 0) return "Queue is empty";
        const currentIdx = this.queue.getCurrentIndex ? this.queue.getCurrentIndex() : -1;
        const lines = songs.map((s, i) => {
          const marker = i === currentIdx ? "▶ " : "  ";
          return `${marker}${i + 1}. ${s.name} - ${s.artist}`;
        });
        return `Queue (${songs.length} songs):\n${lines.join("\n")}`;
      }
    });
    this.controlRouter.registerHandler({
      name: 'list',
      execute: async () => {
        // same as queue for now
        const songs = this.queue.list();
        if (songs.length === 0) return "Queue is empty";
        const currentIdx = this.queue.getCurrentIndex ? this.queue.getCurrentIndex() : -1;
        const lines = songs.map((s, i) => {
          const marker = i === currentIdx ? "▶ " : "  ";
          return `${marker}${i + 1}. ${s.name} - ${s.artist}`;
        });
        return `Queue (${songs.length} songs):\n${lines.join("\n")}`;
      }
    });
    this.controlRouter.registerHandler({
      name: 'help',
      execute: async () => this.generateHelpText()
    });
    this.controlRouter.registerHandler({
      name: 'test',
      execute: async () => this.cmdTest()
    });
    this.controlRouter.registerHandler({
      name: 'lyrics',
      execute: async (cmd) => {
        if (!cmd.args) return "Usage: !lyrics <song name or queue number>";
        // Minimal implementation: try to get current song lyrics via provider if possible
        const current = this.queue.current();
        if (current) {
          try {
            const provider = this.getProviderFor(current.platform);
            const lyrics = await provider.getLyrics(current.id);
            if (lyrics && lyrics.length > 0) {
              const lines = lyrics.slice(0, 8).map(l => l.text).join("\n");
              return `Lyrics for ${current.name}:\n${lines}`;
            }
          } catch {}
        }
        return "Lyrics not available for current track (or specify a song).";
      }
    });

    // === Remaining complex commands (direct minimal implementations) ===
    this.controlRouter.registerHandler({
      name: 'vote',
      execute: async (cmd, ctx, msg: any) => {
        if (!msg) return "Vote only works in TeamSpeak chat.";
        this.voteSkipUsers.add(msg.invokerUid);
        return "Vote recorded.";
      }
    });

    this.controlRouter.registerHandler({
      name: 'move',
      execute: async (cmd) => {
        // Basic move (simplified - full move logic can be expanded)
        return "Move command temporarily limited in new router. Use legacy if needed.";
      }
    });

    this.controlRouter.registerHandler({
      name: 'follow',
      execute: async (cmd) => {
        if (!cmd.args) return "Usage: !follow <username>";
        // Stub for now
        return `Following ${cmd.args} (not fully implemented in router yet).`;
      }
    });

    // === Roast / community layer (ROADMAP Phase 8) ===
    this.controlRouter.registerHandler({
      name: 'roast',
      execute: async () => {
        if (!this.config.roastEnabled) {
          return "The roast is switched off. An admin can enable it in Settings.";
        }
        const reel = this.buildRoastReel();
        return reel ?? "Nothing roast-worthy graded yet — give it time.";
      }
    });
    this.controlRouter.registerHandler({
      name: 'roastout',
      execute: async (cmd, ctx) => {
        if (!ctx.invokerUid) return "Couldn't identify you — opt-out not applied.";
        const removed = this.roastStore.optOut(ctx.invokerUid);
        return `You're out of the roast. Purged ${removed} captured line${removed === 1 ? "" : "s"} and stopped recording you.`;
      }
    });

    // Note: "fm" and "artist" were NetEase-specific and removed during de-sinicization.
  }

  // === Roast / community layer (ROADMAP Phase 8) ===

  /**
   * Record one chat line as roast material. Skips commands, private DMs, the
   * bot's own echoed messages, and opted-out users. Gated on roastEnabled and
   * best-effort (a capture failure must never break message handling).
   */
  private captureRoastLine(msg: TS3TextMessage): void {
    if (!this.config.roastEnabled) return;
    if (msg.targetMode === 1) return; // don't mine private DMs
    if (msg.invokerId === String(this.tsClient.getClientId())) return; // not the bot itself
    const text = msg.message?.trim();
    if (!text || text.length < 3) return;
    if (text.startsWith(this.config.commandPrefix)) return; // commands aren't roast material
    if (!msg.invokerUid) return;
    try {
      if (this.roastStore.isOptedOut(msg.invokerUid)) return;
      this.roastStore.add(msg.invokerUid, msg.invokerName || "someone", text);
    } catch (err) {
      this.logger.debug({ err }, "Roast capture failed");
    }
  }

  /**
   * One roast pass, fired from the idle poller: grade a batch of captured lines,
   * then maybe drop a "greatest hits" compilation if enough people are present.
   * Serialized via {@link roastCompiling} so slow NPU grading can't overlap with
   * the next 30s tick. Best-effort — never throws into the poller.
   */
  private async runRoastTick(humanCount: number): Promise<void> {
    if (!this.config.roastEnabled || this.roastCompiling) return;
    this.roastCompiling = true;
    try {
      await this.gradeRoastBatch();
      await this.maybeRoast(humanCount);
    } catch (err) {
      this.logger.debug({ err }, "Roast tick failed");
    } finally {
      this.roastCompiling = false;
    }
  }

  /**
   * Grade the oldest ungraded lines with the LLM (0–10 cringe + one-line reason).
   * Batched and small because the local NPU is slow (~4.5 tok/s). On an empty
   * LLM response (model down) we stop early and retry next tick; on a non-empty
   * but unparseable reply we mark the line graded-0 so it can't wedge the queue.
   */
  private async gradeRoastBatch(): Promise<void> {
    if (!this.llmModule) return; // grading needs the LLM
    const batch = this.roastStore.ungraded(5);
    if (batch.length === 0) return;
    const system =
      "You are a ruthless but witty roast judge. Score how cringe or embarrassing " +
      "a single chat line is, from 0 (forgettable) to 10 (maximally cringe). Reply " +
      'with ONLY a JSON object: {"score": <integer 0-10>, "reason": "<short reason>"}.';
    for (const q of batch) {
      const out = await this.llmModule.complete(
        `Chat line from ${q.userName}: ${JSON.stringify(q.text)}`,
        system,
      );
      if (!out) {
        this.logger.debug("Roast grader got no LLM response — retrying next tick");
        return; // LLM unavailable; leave the rest ungraded
      }
      const parsed = parseRoastGrade(out);
      if (parsed) this.roastStore.setGrade(q.id, parsed.score, parsed.reason);
      else this.roastStore.setGrade(q.id, 0, "ungradeable");
    }
  }

  /**
   * Post a roast compilation if {@link BotConfig.roastMinPresent}+ humans are in
   * the channel and the cooldown has elapsed. Records {@link lastRoastAt} only
   * when a reel actually goes out, so a presence flap doesn't burn the cooldown.
   */
  private async maybeRoast(humanCount: number): Promise<void> {
    if (humanCount < this.config.roastMinPresent) return;
    const cooldownMs = this.config.roastCooldownMinutes * 60_000;
    if (Date.now() - this.lastRoastAt < cooldownMs) return;
    const reel = this.buildRoastReel();
    if (!reel) return;
    this.lastRoastAt = Date.now();
    await this.tsClient.sendTextMessage(reel);
  }

  /** Format the top graded lines into a chat-ready reel, or null if none graded. */
  private buildRoastReel(): string | null {
    const top = this.roastStore.top(5);
    if (top.length === 0) return null;
    const lines = top.map(
      (q, i) =>
        `${i + 1}. ${q.userName} (${q.score}/10): "${q.text}"` +
        (q.reason ? ` — ${q.reason}` : ""),
    );
    return `🔥 Roast reel — today's greatest hits 🔥\n${lines.join("\n")}`;
  }

  private generateHelpText(): string {
    const askLine = this.controlRouter.hasLlm() ? "\n!ask <question> — Ask the local AI" : "";
    return `Available commands:
!play <query> [-l local / -y youtube]
!add <query>
!skip / !next
!pause / !resume / !stop
!vol <0-100>
!mode seq|loop|random|rloop
!queue / !now
!clear / !remove <n>
!test${askLine}
!help`;
  }

  /**
   * Public method for the ControlRouter to directly play a pre-resolved item
   * (especially from LocalProvider.resolve). This lets the router drive execution
   * for the primary local source without going through the old search path.
   */
  async playResolvedItem(
    resolved: { type: 'song' | 'playlist'; item: any },
    platform: 'local' | 'youtube' | 'stream' = 'local'
  ): Promise<string> {
    if (resolved.type === 'playlist') {
      const songs = await this.localProvider.getPlaylistSongs(resolved.item.id);
      if (songs.length === 0) {
        return `Playlist "${resolved.item.name}" is empty or could not be loaded.`;
      }
      this.queue.clear();
      this.queue.addMany(songs.map(s => ({ ...s, platform })));
      this.queue.play();
      this.player.resetFailures();

      const first = this.queue.current()!;
      const ok = await this.resolveAndPlay(first);
      this.emit("stateChange");
      return ok
        ? `Playing playlist: ${resolved.item.name} (${songs.length} tracks)`
        : `Failed to start playlist: ${resolved.item.name}`;
    } else {
      // song
      this.queue.clear();
      this.queue.add({ ...resolved.item, platform });
      this.queue.play();
      this.player.resetFailures();

      const ok = await this.resolveAndPlay(this.queue.current()!);
      this.emit("stateChange");
      return ok
        ? `Now playing: ${resolved.item.name} - ${resolved.item.artist} (local)`
        : `Cannot play: ${resolved.item.name}`;
    }
  }

  /**
   * Public method for the ControlRouter to add a pre-resolved item.
   */
  async addResolvedItem(
    resolved: { type: 'song' | 'playlist'; item: any },
    platform: 'local' | 'youtube' | 'stream' = 'local'
  ): Promise<string> {
    if (resolved.type === 'playlist') {
      const songs = await this.localProvider.getPlaylistSongs(resolved.item.id);
      if (songs.length === 0) return `Playlist is empty.`;

      const wasIdle = this.player.getState() === "idle";
      this.queue.addMany(songs.map(s => ({ ...s, platform })));

      if (wasIdle) {
        this.queue.playAt(this.queue.size() - songs.length);
        this.player.resetFailures();
        await this.resolveAndPlay(this.queue.current()!);
        this.emit("stateChange");
        return `Added playlist "${resolved.item.name}" and started playback.`;
      }
      this.emit("stateChange");
      return `Added playlist "${resolved.item.name}" (${songs.length} tracks) to queue.`;
    } else {
      const wasIdle = this.player.getState() === "idle";
      this.queue.add({ ...resolved.item, platform });

      if (wasIdle) {
        this.queue.playAt(this.queue.size() - 1);
        this.player.resetFailures();
        await this.resolveAndPlay(this.queue.current()!);
        this.emit("stateChange");
        return `Now playing: ${resolved.item.name} - ${resolved.item.artist}`;
      }
      this.emit("stateChange");
      return `Added to queue: ${resolved.item.name} - ${resolved.item.artist}`;
    }
  }

  // === Router-friendly low-level control methods ===
  // These allow the ControlRouter (and future handlers) to directly drive playback
  // with minimal knowledge of internal queue/player details.

  /** Clear the queue and stop current playback (used by router for 'stop', 'clear', etc.) */
  clearQueueAndStop(): void {
    this.queue.clear();
    this.player.stop();
    this.emit("stateChange");
  }

  /** Skip to next track */
  async skipNext(): Promise<void> {
    const next = this.queue.next();
    if (next) {
      await this.resolveAndPlay(next);
    } else {
      this.player.stop();
    }
    this.emit("stateChange");
  }

  /** Pause current playback */
  pausePlayback(): void {
    this.player.pause();
    this.emit("stateChange");
  }

  /** Resume playback */
  resumePlayback(): void {
    this.player.resume();
    this.emit("stateChange");
  }

  /** Set volume (0-100) */
  setVolume(volume: number): void {
    this.player.setVolume(Math.max(0, Math.min(100, volume)));
    this.emit("stateChange");
  }

  /** Resolve URL for a song and start playing it. Skips to next if URL fails. */
  async resolveAndPlay(song: QueuedSong): Promise<boolean> {
    if (!this.connected) {
      this.logger.warn({ songId: song.id, name: song.name }, "resolveAndPlay called on disconnected bot — skipping");
      return false;
    }
    // Clear any accumulated skip votes — every fresh track starts with a
    // clean slate, regardless of which code path loaded it (cmdPlay,
    // cmdPlaylist, cmdAlbum, cmdFm, trackEnd auto-advance, etc.).
    this.voteSkipUsers.clear();
    const provider = this.getProviderFor(song.platform);
    try {
      const url = await provider.getSongUrl(song.id);
      if (!url) {
        this.logger.warn({ songId: song.id, name: song.name }, "No URL available, skipping");
        return false;
      }
      // Re-check connection state AFTER the network round-trip — the URL
      // resolve can take multiple seconds and the user may have called stop
      // during that window. Without this, we'd spawn ffmpeg on a
      // disconnected bot and land back in the same "connected=false but
      // playing=true" inconsistency that Bug C was about.
      if (!this.connected) {
        this.logger.warn(
          { songId: song.id, name: song.name },
          "bot disconnected during URL resolve — aborting playback",
        );
        return false;
      }
      song.url = url;
      this.player.play(url, 0, song.duration);
      this.database.addPlayHistory({
        botId: this.id,
        songId: song.id,
        songName: song.name,
        artist: song.artist,
        album: song.album,
        platform: song.platform,
        coverUrl: song.coverUrl,
      });
      // Update bot presence (fire-and-forget — never blocks playback)
      this.profileManager.onSongChange(song).catch((err) => {
        this.logger.warn({ err }, "Profile update failed after song change");
      });
      this.emit("stateChange");
      return true;
    } catch (err) {
      this.logger.error({ err, songId: song.id }, "Failed to resolve URL");
      return false;
    }
  }

  private async cmdPlay(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !play <song name or URL>";

    // Note: Strong local resolve (using LocalProvider.resolve) is now attempted earlier
    // in the ControlRouter.route() phase for "play" commands. If a high-certainty local
    // match was found, the router decision carries it. For now we still support the
    // normal search path here as fallback (and for YouTube/Stream).

    const hit = await this.searchFirst(cmd, 1);
    if (!hit) return `No results found for: ${cmd.args}`;
    const { provider, song } = hit;
    this.queue.clear();
    this.queue.add({ ...song, platform: provider.platform });
    this.queue.play();

    // Reset failure counter on user-initiated play
    this.player.resetFailures();
    const ok = await this.resolveAndPlay(this.queue.current()!);
    if (!ok) return `Cannot play: ${song.name}`;
    return `Now playing: ${song.name} - ${song.artist}`;
  }

  private async cmdAdd(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !add <song name>";
    const hit = await this.searchFirst(cmd, 1);
    if (!hit) return `No results found for: ${cmd.args}`;
    const { provider, song } = hit;
    const wasIdle = this.player.getState() === "idle";
    this.queue.add({ ...song, platform: provider.platform });

    // If nothing was playing, start this newly-added song immediately.
    // Matches /api/player/:id/add-by-id behavior so both add paths feel
    // the same to the user (add to idle bot → plays now).
    if (wasIdle) {
      this.queue.playAt(this.queue.size() - 1);
      this.player.resetFailures();
      await this.resolveAndPlay(this.queue.current()!);
      this.emit("stateChange");
      return `Now playing: ${song.name} - ${song.artist}`;
    }

    this.emit("stateChange");
    return `Added to queue: ${song.name} - ${song.artist} (position ${this.queue.size()})`;
  }

  private async cmdPlayNext(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !playnext <song name>";
    const hit = await this.searchFirst(cmd, 1);
    if (!hit) return `No results found for: ${cmd.args}`;
    const { provider, song } = hit;
    const wasIdle = this.player.getState() === "idle";
    // Capture the slot addNext WILL insert at, before mutating the queue.
    // addNext pushes when currentIndex<0 (slot = size); otherwise splices
    // at currentIndex+1. Using size-1 after addNext was wrong when the
    // queue had stale currentIndex>=0 while the player was idle (e.g.,
    // after natural track end without queue.clear()).
    const insertedAt =
      this.queue.getCurrentIndex() < 0
        ? this.queue.size()
        : this.queue.getCurrentIndex() + 1;
    this.queue.addNext({ ...song, platform: provider.platform });

    if (wasIdle) {
      this.queue.playAt(insertedAt);
      this.player.resetFailures();
      const ok = await this.resolveAndPlay(this.queue.current()!);
      this.emit("stateChange");
      if (!ok) return `Cannot play: ${song.name}`;
      return `Now playing: ${song.name} - ${song.artist}`;
    }

    this.emit("stateChange");
    return `Up next: ${song.name} - ${song.artist}`;
  }

  private cmdPause(): string {
    this.player.pause();
    this.emit("stateChange");
    return "Paused";
  }

  private cmdResume(): string {
    this.player.resume();
    this.emit("stateChange");
    return "Resumed";
  }

  private cmdStop(): string {
    this.player.stop();
    this.queue.clear();
    // (FM mode removed)
    this.profileManager.onSongChange(null).catch((err) => {
      this.logger.warn({ err }, "Profile restore failed on stop");
    });
    this.emit("stateChange");
    return "Stopped and queue cleared";
  }

  private async cmdNext(): Promise<string> {
    await this.playNext();
    const current = this.queue.current();
    if (current)
      return `Now playing: ${current.name} - ${current.artist}`;
    return "Queue is empty";
  }

  private async cmdPrev(): Promise<string> {
    // Retry-skip up to 4 attempts: history can include failed songs
    // that playNext's auto-advance retry-skipped past, so a single
    // prev would otherwise land on an unplayable song and leave the
    // queue's currentIndex stuck mid-failure.
    for (let i = 0; i < 4; i++) {
      const prev = this.queue.prev();
      if (!prev) return "No previous song";
      const ok = await this.resolveAndPlay(prev);
      if (ok) return `Now playing: ${prev.name} - ${prev.artist}`;
    }
    return "Cannot play any previous songs (all failed to resolve)";
  }

  private cmdVol(cmd: ParsedCommand): string {
    const vol = parseInt(cmd.args, 10);
    if (isNaN(vol) || vol < 0 || vol > 100) return "Usage: !vol <0-100>";
    this.player.setVolume(vol);
    this.emit("stateChange");
    return `Volume set to ${vol}%`;
  }

  private cmdNow(): string {
    const song = this.queue.current();
    if (!song) return "Nothing is playing";
    return `Now playing: ${song.name} - ${song.artist} [${song.album}] (${song.platform})`;
  }

  private cmdQueue(): string {
    const songs = this.queue.list();
    if (songs.length === 0) return "Queue is empty";
    const currentIdx = this.queue.getCurrentIndex();
    const lines = songs.map((s, i) => {
      const marker = i === currentIdx ? "▶ " : "  ";
      return `${marker}${i + 1}. ${s.name} - ${s.artist}`;
    });
    return `Queue (${songs.length} songs, mode: ${this.queue.getMode()}):\n${lines.join("\n")}`;
  }

  private cmdClear(): string {
    this.player.stop();
    this.queue.clear();
    // (FM mode removed)
    this.profileManager.onSongChange(null).catch((err) => {
      this.logger.warn({ err }, "Profile restore failed on clear");
    });
    this.emit("stateChange");
    return "Queue cleared";
  }

  private cmdRemove(cmd: ParsedCommand): string {
    const index = parseInt(cmd.args, 10) - 1;
    if (isNaN(index) || index < 0) return "Usage: !remove <number>";
    const removed = this.queue.remove(index);
    if (!removed) return "Invalid position";
    this.emit("stateChange");
    return `Removed: ${removed.name}`;
  }

  private cmdMode(cmd: ParsedCommand): string {
    const modeMap: Record<string, PlayMode> = {
      seq: PlayMode.Sequential,
      loop: PlayMode.Loop,
      random: PlayMode.Random,
      rloop: PlayMode.RandomLoop,
    };
    const mode = modeMap[cmd.args];
    if (mode === undefined) return "Usage: !mode <seq|loop|random|rloop>";
    this.queue.setMode(mode);
    this.emit("stateChange");
    return `Play mode set to: ${cmd.args}`;
  }

  private async cmdPlaylist(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !playlist <playlist name or ID>";
    const provider = this.getProvider(cmd.flags);

    // Determine if input is a numeric ID or a name search
    const id = this.extractId(cmd.args);
    const isNumericId = /^\d+$/.test(cmd.args.trim());

    let playlistId: string;

    if (isNumericId || id !== cmd.args) {
      // Input is a numeric ID or URL containing an ID — use existing logic
      playlistId = id;
    } else {
      // Name-based search
      const result = await provider.search(cmd.args);
      let playlists = result.playlists ?? [];

      // Also search user's personal playlists if logged in
      if (provider.getUserPlaylists) {
        try {
          const userPlaylists = await provider.getUserPlaylists();
          const query = cmd.args.toLowerCase();
          const matched = userPlaylists.filter(
            p => p.name.toLowerCase().includes(query)
          );
          // Merge: public results first (API-ranked), then user matches
          playlists = [...playlists, ...matched];
        } catch {
          // User playlists unavailable — continue with public results
        }
      }

      if (playlists.length === 0)
        return `No playlists found for: ${cmd.args}`;
      playlistId = playlists[0].id;
    }

    const songs = await provider.getPlaylistSongs(playlistId);
    if (songs.length === 0) return "Playlist is empty or not found";

    this.queue.clear();
    for (const song of songs) {
      this.queue.add({ ...song, platform: provider.platform });
    }
    const first = this.queue.play();
    if (first) await this.resolveAndPlay(first);
    this.emit("stateChange");
    return `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}`;
  }

  private async cmdAlbum(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !album <album name or ID>";
    const provider = this.getProvider(cmd.flags);

    const id = this.extractId(cmd.args);
    const isNumericId = /^\d+$/.test(cmd.args.trim());

    let albumId: string;

    if (isNumericId || id !== cmd.args) {
      // Input is a numeric ID or URL containing an ID — use directly
      albumId = id;
    } else {
      // Name-based search
      const result = await provider.search(cmd.args);
      const albums = result.albums ?? [];
      if (albums.length === 0)
        return `No albums found for: ${cmd.args}`;
      albumId = albums[0].id;
    }

    const songs = await provider.getAlbumSongs(albumId);
    if (songs.length === 0) return "Album is empty or not found";

    this.queue.clear();
    for (const song of songs) {
      this.queue.add({ ...song, platform: provider.platform });
    }
    const first = this.queue.play();
    if (first) await this.resolveAndPlay(first);
    this.emit("stateChange");
    return `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}`;
  }

  private async cmdFm(): Promise<string> {
    return "fm command removed (was NetEase-only). Use !play with YouTube or Local sources.";
  }

  private async cmdArtist(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !artist <artist name>";
    // Phase 0: artist search falls back to the single active provider (YouTube)
    const provider = this.getProvider(cmd.flags);
    const result = await provider.search(cmd.args, 50);
    if (result.songs.length === 0)
      return `No results found for artist: ${cmd.args}`;

    const query = cmd.args.toLowerCase();
    let filtered = result.songs.filter(
      s => s.artist.toLowerCase().includes(query)
    );

    if (filtered.length === 0) {
      filtered = result.songs.slice(0, 20);
    }

    this.queue.clear();
    for (const song of filtered) {
      this.queue.add({ ...song, platform: provider.platform });
    }
    this.queue.setMode(PlayMode.Loop);
    this.player.resetFailures();

    const first = this.queue.play();
    if (first) await this.resolveAndPlay(first);
    this.emit("stateChange");
    return `Artist mode: ${cmd.args} — ${filtered.length} songs loaded. Now playing: ${first?.name ?? "unknown"}`;
  }

  private async refillFm(): Promise<void> {
    // FM feature removed during de-sinicization (was NetEase-only)
    return;
  }

  private async cmdVote(msg?: TS3TextMessage): Promise<string> {
    if (!msg) return "Vote can only be used in TeamSpeak";
    this.voteSkipUsers.add(msg.invokerUid);
    const clients = await this.tsClient.getClientsInChannel();
    const totalUsers = clients.length - 1; // exclude the bot itself
    // At least 1 vote is always required — otherwise a single voter in an
    // otherwise empty channel (or a transient clients.length=1 race) could
    // unanimously "win" with needed=0.
    const needed = Math.max(1, Math.ceil(totalUsers / 2));
    const votes = this.voteSkipUsers.size;

    if (votes >= needed) {
      this.voteSkipUsers.clear();
      this.playNext().catch((err) => {
        this.logger.error({ err }, "playNext failed after vote skip");
      });
      return `Vote passed (${votes}/${needed}). Skipping to next song.`;
    }
    return `Vote to skip: ${votes}/${needed} (need ${needed - votes} more)`;
  }

  private async cmdLyrics(): Promise<string> {
    const song = this.queue.current();
    if (!song) return "Nothing is playing";
    const provider = this.getProviderFor(song.platform);
    const lyrics = await provider.getLyrics(song.id);
    if (lyrics.length === 0) return "No lyrics available";
    const lines = lyrics.slice(0, 10).map((l) => l.text);
    return `Lyrics for ${song.name}:\n${lines.join("\n")}`;
  }

  private async cmdMove(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !move <channel name or ID>";
    await this.tsClient.joinChannel(cmd.args);
    return `Moved to channel: ${cmd.args}`;
  }

  private async cmdFollow(msg?: TS3TextMessage): Promise<string> {
    if (!msg) return "Follow can only be used in TeamSpeak";
    return "Following you to your channel";
  }

  private cmdHelp(): string {
    const p = this.config.commandPrefix;
    return [
      "Moneypenny Commands:",
      `${p}play <song>  — Search and play (Local primary, or YouTube)`,
      `${p}play -y <song> — Search from YouTube (yt-dlp)`,
      `${p}play <path>  — Play local file or M3U playlist by path (under MUSIC_DIR)`,
      `${p}add <song>   — Add to queue`,
      `${p}playnext <song> — Insert as next song (alias: ${p}pn)`,
      `${p}pause/resume — Pause/resume`,
      `${p}next/prev    — Next/previous`,
      `${p}stop         — Stop and clear queue`,
      `${p}vol <0-100>  — Set volume`,
      `${p}queue        — Show queue`,
      `${p}remove <pos> — Remove song at position (see ${p}queue)`,
      `${p}mode <seq|loop|random|rloop> — Play mode`,
      `${p}playlist <name or id> — Load playlist by name or ID (Local/YouTube)`,
      `${p}album <id>   — Load album (where supported)`,
      `${p}artist <name> — Play songs by artist (loop, Local/YouTube)`,
      `${p}vote         — Vote to skip`,
      `${p}lyrics       — Show lyrics`,
      `${p}now          — Current song info`,
      `${p}test         — Play ${DEFAULT_DEMO_VIDEO_URL}`,
      `${p}help         — This help message`,
    ].join("\n");
  }

  private async cmdTest(): Promise<string> {
    // Play the specific test video requested by the user.
    // Always routes to YouTube provider; clears queue like a fresh !play.
    const testTrack = DEFAULT_DEMO_VIDEO_URL;
    const cmd: ParsedCommand = {
      name: "play",
      args: testTrack,
      rawArgs: [testTrack],
      flags: new Set<string>(),
    };
    return this.cmdPlay(cmd);
  }

  /**
   * Advance the queue and play the next song. If the resolved URL fails
   * (e.g., unplayable source), skips up to `maxRetries`
   * more songs looking for a playable one. Public so REST endpoints that
   * seed the queue can fall back to this retry-skip behavior.
   *
   * Returns true if a song actually started playing, false otherwise.
   */
  async playNext(maxRetries = 3): Promise<boolean> {
    if (this.isAdvancing || !this.connected) return false;
    this.isAdvancing = true;
    try {
      this.voteSkipUsers.clear();
      const next = this.queue.next();
      let started = false;
      if (next) {
        started = await this.resolveAndPlay(next);
        if (!started) {
          for (let i = 0; i < maxRetries && this.connected; i++) {
            const retry = this.queue.next();
            if (!retry) break;
            if (await this.resolveAndPlay(retry)) {
              started = true;
              break;
            }
          }
        }
        if (!started) {
          this.player.stop();
          this.profileManager.onSongChange(null).catch(() => {});
        }
      } else {
        this.player.stop();
        this.profileManager.onSongChange(null).catch(() => {});
      }
      this.emit("stateChange");
      return started;
    } finally {
      this.isAdvancing = false;
    }
  }

  private extractId(input: string): string {
    const match = input.match(/[?&]id=(\d+)/);
    if (match) return match[1];
    const pathMatch = input.match(/\/(\d+)/);
    if (pathMatch) return pathMatch[1];
    return input;
  }

  getStatus(): BotStatus {
    return {
      id: this.id,
      name: this.name,
      connected: this.connected,
      playing: this.player.getState() === "playing",
      paused: this.player.getState() === "paused",
      currentSong: this.queue.current(),
      queueSize: this.queue.size(),
      volume: this.player.getVolume(),
      playMode: this.queue.getMode(),
      elapsed: this.player.getElapsed(),
    };
  }

  getQueue(): QueuedSong[] {
    return this.queue.list();
  }

  getPlayer(): AudioPlayer {
    return this.player;
  }

  getQueueManager(): PlayQueue {
    return this.queue;
  }

  getProfileManager(): BotProfileManager {
    return this.profileManager;
  }

  getIdentityExport(): string | undefined {
    return this.tsClient.getIdentityExport();
  }
}
