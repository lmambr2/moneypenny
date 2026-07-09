import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TS3Client, TS3VoiceData } from "../../ts-protocol/client.js";
import { CODEC_OPUS_VOICE } from "../../ts-protocol/voice.js";
import type { AudioPlayer } from "../../audio/player.js";
import type { PlayQueue, QueuedSong } from "../../audio/queue.js";
import type { BotConfig } from "../../data/config.js";
import type { Logger } from "../../logger.js";
import type { MusicProvider } from "../../music/provider.js";
import type { RightsEngine } from "../../rights/index.js";
import type { Subject } from "../../rights/index.js";
import {
  allowedClassificationsFor,
  resolveSubject as resolveRightsSubject,
} from "../rights/subject.js";
import type { ControlRouter, RouterContext } from "../../control/router.js";
import { createOpusEncoder, type Encoder } from "../../audio/encoder.js";
import { decodeVoiceOpusPacket } from "../../audio/opus-voice.js";
import {
  VoicePipeline,
  SherpaSttClient,
  KokoroTtsClient,
  defaultVoiceConfig,
  isPlaybackControlReply,
  isPlaybackStartReply,
  voiceReplyClearsSavedMusic,
  type TtsProvider,
  type VoiceOutput,
  type StreamSttResult,
  type Utterance,
} from "../../voice/index.js";
import { probeKokoroTts, probeSherpaStt } from "../../voice/probe.js";
import {
  isPcmClipped,
  MIN_PCM_BOOST_PEAK,
  normalizePcmForStt,
  peakAmplitude16,
  STT_TARGET_PEAK,
} from "../../voice/pcm.js";
import { isMusicSearchRouteText } from "../../voice/music-command.js";
import {
  extractCommandSegment,
  extractWatchwordCommand,
  isActionableVoiceCommand,
  isPartialSafeVoiceCommand,
  partialMentionsCommand,
} from "../../voice/watchword.js";
import type { BotInstance } from "../instance.js";

export interface VoiceSessionDeps {
  config: BotConfig;
  logger: Logger;
  tsClient: TS3Client;
  player: AudioPlayer;
  queue: PlayQueue;
  router: ControlRouter;
  bot: BotInstance;
  rightsEngine: () => RightsEngine | null;
  getProviderFor: (platform: "local" | "youtube" | "stream") => MusicProvider;
  isConnected: () => boolean;
  onClientList: (clients: Array<{ id: number; uid: string; serverGroups: string[]; nickname: string }>) => void;
}

/** Voice loop: inbound Opus → STT → ControlRouter → TTS (DESIGN §10). */
export class VoiceSession {
  private pipeline: VoicePipeline | null = null;
  private sttClient: SherpaSttClient | null = null;
  private voiceDecoder: Encoder | null = null;
  private streamBuffers = new Map<
    number,
    {
      chunks: Buffer[];
      channels: number;
      flushTimer: ReturnType<typeof setTimeout> | null;
      idleTimer: ReturnType<typeof setTimeout> | null;
      streamSpeaking: boolean;
      /** Sidecar listening phase mirrored from the last stream chunk. */
      listening: "passive" | "command";
      /** Max boosted PCM peak seen this utterance (for logging). */
      utterancePeak: number;
    }
  >();
  private streamChains = new Map<number, Promise<void>>();
  private readonly streamFlushMs = 80;
  /** Passive KWS — fewer sherpa feeds while no wake word (music + open mics). */
  private readonly passiveStreamFlushMs = 200;
  /** Music bleed keeps passive peaks high — stretch passive flushes further. */
  private readonly passiveMusicFlushMs = 350;
  /** After inbound audio stops, pad silence so Silero VAD can end-point. */
  private readonly streamIdleMs = 1200;
  /** While armed, wait longer for beat-then-command cadence before idle finalize. */
  private readonly armedStreamIdleMs = 3500;
  private readonly silenceTailMs = 900;
  /** Wake phrase (set from voice config in enable()); used to strip wake-bleed from finals. */
  private watchword = "moneypenny";
  private duckWatchdog: ReturnType<typeof setTimeout> | null = null;
  private readonly duckWatchdogMs = 18_000;
  /** After voice pause/stop, TTS trackEnd must not advance the music queue. */
  private suppressNextTrackAdvance = false;
  private segmenterOpts: { sampleRate: number; channels: number; energyThreshold: number } | null = null;
  private tempDir: string | null = null;
  private savedMusic: { song: QueuedSong; elapsed: number } | null = null;
  /** Music volume-ducked at speech onset so bot output does not drown STT. */
  private captureDuck: { song: QueuedSong; elapsed: number } | null = null;
  /** Client whose wake word triggered captureDuck. */
  private captureDuckClientId: number | null = null;
  private duckMusicOnSpeech = true;
  private duckMusicVolume = 25;
  /** Whisper has no KWS — duck on speech energy so text wake can hear over music. */
  private textWakeFallback = false;
  /** Min post-wake window — must cover beat-then-command cadence (≥ sherpa command window). */
  private static readonly MIN_LISTEN_WINDOW_MS = 15_000;
  /** Real speech on the wire — ignore Opus DTX comfort noise below this. */
  private static readonly MIN_SPEECH_PEAK = MIN_PCM_BOOST_PEAK;
  private static readonly ARMED_ENERGY_THRESHOLD = 40;
  /** Brief hold while volume duck applies; keep short so trailing verbs are not clipped. */
  private static readonly DUCK_SETTLE_MS = 25;
  private commandCaptureReadyAt = new Map<number, number>();
  private postDuckSettling = new Set<number>();
  private postDuckResetTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private listenWindowMs = 15_000;
  private armedUntil = new Map<number, number>();
  private armTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private armedKeepaliveTimers = new Map<number, ReturnType<typeof setInterval>>();
  private lastArmedInboundLog = new Map<number, number>();
  private droppedNonVoiceCodec = 0;
  private droppedSelfEcho = 0;
  private droppedPassiveDtx = 0;
  private skippedPassiveComfortNoise = 0;
  private skippedPassiveSpeakerCap = 0;
  private attenuatedClipped = 0;
  /** Recent speech energy per speaker — ranks who gets passive KWS slots. */
  private passiveSpeakerScore = new Map<number, { score: number; updatedAt: number }>();
  /** Speakers currently feeding sherpa passive KWS (for reset on demotion). */
  private passiveKwsEligible = new Set<number>();
  private passiveKwsMaxSpeakers = 2;
  private static readonly PASSIVE_ENERGY_DECAY_MS = 3000;
  private clientInfoCache = new Map<number, { uid: string; serverGroups: string[]; nickname: string }>();
  /** Cached ranked passive KWS speakers; refreshed on score touch / prune. */
  private rankedPassiveCache: number[] = [];
  private rankedPassiveCacheAt = 0;
  private static readonly RANKED_PASSIVE_TTL_MS = 200;
  private voiceHandler: ((v: TS3VoiceData) => void) | null = null;
  private inboundPackets = 0;
  private decodedFrames = 0;
  /** Per-client first-packet marker for voice debug (clientId is reused across sessions). */
  private seenInboundClients = new Set<number>();
  private decodeFailuresByClient = new Map<number, number>();
  private multiFrameRecoveries = 0;
  private segmentedUtterances = 0;
  private lastStatsAt = 0;
  /** Per-speaker generation — stale STT finals are dropped after faster retries. */
  private voiceTurnGen = new Map<number, number>();
  /** Avoid double-routing the same armed partial; cleared on fresh wake / disarm. */
  private partialRoutedCommand = new Map<number, string>();
  /** Per-speaker play-resolve cooldown — blocks STT echo repeats after a slow lookup. */
  private playInFlightUntil = new Map<number, number>();
  private static readonly PLAY_IN_FLIGHT_MS = 12_000;

  constructor(private deps: VoiceSessionDeps) {}

  get isActive(): boolean {
    return this.pipeline != null;
  }

  /** Refresh clientId → groups cache (called from idle poller). */
  refreshClientCache(
    clients: Array<{ id: number; uid: string; serverGroups?: string[]; nickname: string }>,
  ): void {
    if (!this.pipeline) return;
    this.clientInfoCache.clear();
    const live = new Set<number>();
    for (const c of clients) {
      live.add(c.id);
      this.clientInfoCache.set(c.id, {
        uid: c.uid,
        serverGroups: c.serverGroups ?? [],
        nickname: c.nickname,
      });
    }
    this.pruneClientMaps(live);
    this.deps.onClientList(
      clients.map((c) => ({
        id: c.id,
        uid: c.uid,
        serverGroups: c.serverGroups ?? [],
        nickname: c.nickname,
      })),
    );
  }

  /** Drop per-client maps for speakers no longer in channel (multi-day uptime leak). */
  private pruneClientMaps(live: Set<number>): void {
    const drop = (m: Map<number, unknown>) => {
      for (const id of m.keys()) {
        if (!live.has(id)) m.delete(id);
      }
    };
    drop(this.streamBuffers as Map<number, unknown>);
    drop(this.streamChains as Map<number, unknown>);
    drop(this.decodeFailuresByClient as Map<number, unknown>);
    drop(this.lastArmedInboundLog as Map<number, unknown>);
    drop(this.voiceTurnGen as Map<number, unknown>);
    drop(this.playInFlightUntil as Map<number, unknown>);
    drop(this.armedUntil as Map<number, unknown>);
    drop(this.commandCaptureReadyAt as Map<number, unknown>);
    drop(this.passiveSpeakerScore as Map<number, unknown>);
    for (const id of this.seenInboundClients) {
      if (!live.has(id)) this.seenInboundClients.delete(id);
    }
    for (const id of this.passiveKwsEligible) {
      if (!live.has(id)) this.passiveKwsEligible.delete(id);
    }
    this.rankedPassiveCacheAt = 0;
  }

  enable(): void {
    const vc = { ...defaultVoiceConfig(), ...this.deps.config.voice };
    if (!vc?.enabled) return;
    if (!vc.sttUrl) {
      this.deps.logger.warn("Voice enabled but no sttUrl configured — voice loop inactive");
      return;
    }
    const stt = new SherpaSttClient({ url: vc.sttUrl, logger: this.deps.logger });
    this.sttClient = stt;
    const tts: TtsProvider | undefined = vc.ttsUrl
      ? new KokoroTtsClient({ url: vc.ttsUrl, voice: vc.ttsVoice, logger: this.deps.logger })
      : undefined;
    const output: VoiceOutput | undefined = tts ? this.createOutput() : undefined;

    this.voiceDecoder = createOpusEncoder(1);
    this.duckMusicOnSpeech = vc.duckMusicOnSpeech !== false;
    // Legacy product default was 2 (near-mute) — treat as unset and use soft 25.
    const rawDuck = vc.duckMusicVolume;
    const duck = rawDuck === undefined || rawDuck === 2 ? 25 : rawDuck;
    this.duckMusicVolume = Math.max(0, Math.min(100, duck));
    this.textWakeFallback = vc.textWakeFallback ?? false;
    this.listenWindowMs = Math.max(
      vc.listenWindowMs ?? VoiceSession.MIN_LISTEN_WINDOW_MS,
      VoiceSession.MIN_LISTEN_WINDOW_MS,
    );
    this.passiveKwsMaxSpeakers = Math.max(1, Math.min(8, vc.passiveKwsMaxSpeakers ?? 2));
    this.releaseCaptureDuck();
    this.watchword = vc.watchword;
    this.clearAllArmTimers();
    this.segmenterOpts = {
      sampleRate: 48_000,
      channels: 1,
      energyThreshold: vc.energyThreshold ?? 200,
    };
    this.pipeline = new VoicePipeline({
      router: this.deps.router,
      stt,
      tts,
      output,
      respondWithVoice: vc.respondWithVoice && !!output,
      aliases: this.deps.config.commandAliases,
      watchword: vc.watchword,
      requireWatchword: vc.requireWatchword,
      listenWindowMs: this.listenWindowMs,
      textWakeFallback: vc.textWakeFallback ?? false,
      isArmed: (id) => this.isArmed(id),
      // Text-wake (Whisper): arming must also duck music so the follow-up is audible to STT.
      arm: (id) => {
        this.armSpeaker(id);
        this.ensureMusicDuckedOnWake(id);
      },
      disarm: (id) => this.disarmSpeaker(id),
      isPlayInFlight: (id) => this.isPlayInFlight(id),
      markPlayInFlight: (id, query) => this.markPlayInFlight(id, query),
      clearPlayInFlight: (id) => this.clearPlayInFlight(id),
      logger: this.deps.logger,
      buildContext: (u) => this.buildContext(u),
      onTurn: ({ transcript, reply, speakerUid }) =>
        this.deps.logger.info({ transcript, reply, speakerUid }, "Voice turn"),
    });
    this.cleanup();
    this.inboundPackets = 0;
    this.decodedFrames = 0;
    this.seenInboundClients.clear();
    this.decodeFailuresByClient.clear();
    this.multiFrameRecoveries = 0;
    this.droppedPassiveDtx = 0;
    this.skippedPassiveComfortNoise = 0;
    this.skippedPassiveSpeakerCap = 0;
    this.passiveSpeakerScore.clear();
    this.passiveKwsEligible.clear();
    this.segmentedUtterances = 0;
    this.lastStatsAt = 0;
    this.voiceTurnGen.clear();
    this.playInFlightUntil.clear();
    this.voiceHandler = (v: TS3VoiceData) => this.handleVoiceData(v);
    this.deps.tsClient.on("voiceData", this.voiceHandler);
    this.deps.tsClient.ensureInboundVoiceCapture();
    this.deps.logger.info(
      {
        stt: true,
        tts: !!tts,
        energyThreshold: this.segmenterOpts.energyThreshold,
        watchword: vc.requireWatchword ? vc.watchword : "(disabled)",
        duckMusicOnSpeech: this.duckMusicOnSpeech,
        duckMusicVolume: this.duckMusicVolume,
        passiveKwsMaxSpeakers: this.passiveKwsMaxSpeakers,
      },
      "Voice pipeline enabled (streaming STT)",
    );
  }

  /** Sidecar + pipeline status for the Settings voice smoke panel. */
  async getStatus(): Promise<{
    enabled: boolean;
    active: boolean;
    sttUrl: string;
    ttsUrl: string;
    ttsVoice: string;
    respondWithVoice: boolean;
    sttAvailable: boolean;
    ttsAvailable: boolean;
    energyThreshold: number;
    watchword: string;
    requireWatchword: boolean;
    inboundPackets: number;
  }> {
    const vc = { ...defaultVoiceConfig(), ...this.deps.config.voice };
    const [sttAvailable, ttsAvailable] = await Promise.all([
      vc.sttUrl ? probeSherpaStt(vc.sttUrl) : Promise.resolve(false),
      vc.ttsUrl ? probeKokoroTts(vc.ttsUrl, vc.ttsVoice) : Promise.resolve(false),
    ]);
    return {
      enabled: !!vc.enabled,
      active: this.pipeline != null,
      sttUrl: vc.sttUrl,
      ttsUrl: vc.ttsUrl,
      ttsVoice: vc.ttsVoice,
      respondWithVoice: vc.respondWithVoice,
      sttAvailable,
      ttsAvailable,
      energyThreshold: vc.energyThreshold ?? 200,
      watchword: vc.watchword,
      requireWatchword: vc.requireWatchword,
      inboundPackets: this.inboundPackets,
    };
  }

  /**
   * Admin smoke test: feed a transcript directly (skips STT + Opus decode).
   * Does not play into the TS channel when `speak` is false.
   */
  async runSyntheticTurn(transcript: string, opts: { speak?: boolean } = {}): Promise<{
    transcript: string;
    reply: string | null;
    ttsBytes: number;
  }> {
    if (!this.pipeline) {
      throw new Error("Voice pipeline is not active — enable voice in Settings and ensure STT URL is set");
    }
    const utterance: Utterance = {
      speakerClientId: 0,
      speakerUid: "voice-smoke-test",
      pcm: Buffer.alloc(0),
      sampleRate: 16000,
      channels: 1,
      durationMs: 0,
    };
    const out = await this.pipeline.handleTranscript(transcript.trim(), utterance, {
      ...opts,
      textWakeFallback: true,
    });
    return { transcript: transcript.trim(), ...out };
  }

  /** Tear down STT/TTS listeners (Settings toggle off or config change). */
  disable(): void {
    if (this.voiceHandler) {
      this.deps.tsClient.off("voiceData", this.voiceHandler);
      this.deps.tsClient.releaseInboundVoiceCapture();
      this.voiceHandler = null;
    }
    this.pipeline = null;
    this.sttClient = null;
    this.voiceDecoder = null;
    this.segmenterOpts = null;
    this.releaseCaptureDuck();
    this.duckMusicOnSpeech = true;
    this.duckMusicVolume = 25;
    this.textWakeFallback = false;
    this.clearAllArmTimers();
    this.cleanup();
    this.deps.logger.info("Voice pipeline disabled");
  }

  /**
   * Player trackEnd hook — resume interrupted music or swallow the event when a
   * voice transport command (pause/stop) just finished speaking.
   */
  async handleTrackEnd(playNext: () => Promise<boolean>): Promise<boolean> {
    if (this.suppressNextTrackAdvance) {
      this.suppressNextTrackAdvance = false;
      this.deps.logger.info("Voice: holding queue after pause/stop reply");
      return true;
    }
    return this.tryResumeMusic(playNext);
  }

  /** After a voice reply ends, try to resume interrupted music. Returns true if resume attempted. */
  async tryResumeMusic(playNext: () => Promise<boolean>): Promise<boolean> {
    if (!this.savedMusic) return false;
    const saved = this.savedMusic;
    this.savedMusic = null;
    const current = this.deps.queue.current();
    if (!current || current.id !== saved.song.id) {
      await playNext();
      return true;
    }
    try {
      const provider = this.deps.getProviderFor(saved.song.platform);
      const url = await provider.getSongUrl(saved.song.id);
      if (url && this.deps.isConnected()) {
        this.deps.player.resetFailures();
        this.deps.player.play(url, saved.elapsed, saved.song.duration || 0);
        return true;
      }
    } catch (err) {
      this.deps.logger.warn({ err }, "Failed to resume interrupted music after voice");
    }
    await playNext();
    return true;
  }

  onPlayerError(): void {
    this.savedMusic = null;
  }

  cleanup(): void {
    this.clearDuckWatchdog();
    for (const buf of this.streamBuffers.values()) {
      if (buf.flushTimer) clearTimeout(buf.flushTimer);
      if (buf.idleTimer) clearTimeout(buf.idleTimer);
    }
    this.streamBuffers.clear();
    this.streamChains.clear();
    this.passiveSpeakerScore.clear();
    this.passiveKwsEligible.clear();
    if (this.tempDir) {
      try {
        rmSync(this.tempDir, { recursive: true, force: true });
      } catch { /* best effort */ }
      this.tempDir = null;
    }
  }

  private touchPassiveEnergy(clientId: number, rawPeak: number): void {
    const now = Date.now();
    const prev = this.passiveSpeakerScore.get(clientId);
    const score =
      prev && now - prev.updatedAt < VoiceSession.PASSIVE_ENERGY_DECAY_MS
        ? Math.max(rawPeak, Math.round(prev.score * 0.85))
        : rawPeak;
    this.passiveSpeakerScore.set(clientId, { score, updatedAt: now });
    this.rankedPassiveCacheAt = 0;
  }

  private rankedPassiveSpeakers(): number[] {
    const now = Date.now();
    if (
      this.rankedPassiveCacheAt > 0 &&
      now - this.rankedPassiveCacheAt < VoiceSession.RANKED_PASSIVE_TTL_MS
    ) {
      return this.rankedPassiveCache;
    }
    // Prune expired passive scores while ranking.
    for (const [id, v] of this.passiveSpeakerScore) {
      if (now - v.updatedAt >= VoiceSession.PASSIVE_ENERGY_DECAY_MS) {
        this.passiveSpeakerScore.delete(id);
      }
    }
    this.rankedPassiveCache = [...this.passiveSpeakerScore.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, this.passiveKwsMaxSpeakers)
      .map(([id]) => id);
    this.rankedPassiveCacheAt = now;
    return this.rankedPassiveCache;
  }

  private isPassiveKwsEligible(clientId: number): boolean {
    return this.rankedPassiveSpeakers().includes(clientId);
  }

  private prunePassiveKwsEligible(): void {
    const keep = new Set(this.rankedPassiveSpeakers());
    for (const clientId of this.passiveKwsEligible) {
      if (keep.has(clientId)) continue;
      const buf = this.streamBuffers.get(clientId);
      const inCapture =
        this.isArmed(clientId) ||
        buf?.listening === "command" ||
        !!this.captureDuck;
      if (!inCapture) this.syncPassiveKwsEligibility(clientId, false);
    }
  }

  private syncPassiveKwsEligibility(clientId: number, eligible: boolean): void {
    const was = this.passiveKwsEligible.has(clientId);
    if (eligible) {
      this.passiveKwsEligible.add(clientId);
      return;
    }
    if (!was) return;
    this.passiveKwsEligible.delete(clientId);
    const buf = this.streamBuffers.get(clientId);
    if (buf) {
      buf.chunks = [];
      if (buf.flushTimer) {
        clearTimeout(buf.flushTimer);
        buf.flushTimer = null;
      }
    }
    void this.sttClient?.resetStream(clientId);
  }

  private handleVoiceData(v: TS3VoiceData): void {
    if (!this.pipeline || !this.voiceDecoder || !this.segmenterOpts) return;

    // STT only consumes human voice codec — bot outbound music uses codec 5.
    if (v.codec !== CODEC_OPUS_VOICE) {
      this.droppedNonVoiceCodec++;
      return;
    }

    const botClientId = this.deps.tsClient.getClientId();
    if (botClientId > 0 && v.clientId === botClientId) {
      this.droppedSelfEcho++;
      return;
    }

    this.inboundPackets++;
    if (!this.seenInboundClients.has(v.clientId)) {
      this.seenInboundClients.add(v.clientId);
      this.deps.logger.info(
        { clientId: v.clientId, codec: v.codec, opusBytes: v.data.length },
        "Voice: first inbound packet from client",
      );
    } else if (this.inboundPackets % 500 === 0) {
      this.prunePassiveKwsEligible();
      this.logInboundStats();
    }

    let buf = this.streamBuffers.get(v.clientId);
    const inCapture =
      this.isArmed(v.clientId) ||
      buf?.listening === "command" ||
      !!this.captureDuck;

    const channels = 1;
    const decoded = decodeVoiceOpusPacket(this.voiceDecoder, v.data);
    if (!decoded.ok) {
      if (decoded.reason === "dtx") {
        this.droppedPassiveDtx++;
      } else if (decoded.reason === "corrupt") {
        this.logDecodeFailure(v.clientId, v.data.length);
      }
      return;
    }
    if (decoded.frames > 1) this.multiFrameRecoveries++;
    const pcm = decoded.pcm;
    this.decodedFrames += decoded.frames;
    const rawPeak = peakAmplitude16(pcm);
    if (isPcmClipped(pcm)) {
      this.attenuatedClipped++;
      if (this.attenuatedClipped <= 5 || this.attenuatedClipped % 100 === 0) {
        this.deps.logger.warn(
          { clientId: v.clientId, rawPeak, count: this.attenuatedClipped },
          "Voice: inbound PCM clipped — will attenuate for STT",
        );
      }
    }
    const isSpeech = rawPeak >= VoiceSession.MIN_SPEECH_PEAK;

    if (!inCapture && isSpeech) {
      this.touchPassiveEnergy(v.clientId, rawPeak);
      // Text-wake over music: duck early so Whisper can hear "Moneypenny …".
      // (KWS path ducks only on keyword; Whisper has no KWS.)
      if (this.textWakeFallback && this.duckMusicOnSpeech) {
        this.ensureMusicDuckedOnWake(v.clientId);
      }
    }

    if (!inCapture && !isSpeech) {
      this.skippedPassiveComfortNoise++;
      return;
    }

    const passiveEligible = inCapture || this.isPassiveKwsEligible(v.clientId);
    this.syncPassiveKwsEligibility(v.clientId, passiveEligible);
    if (!passiveEligible) {
      this.skippedPassiveSpeakerCap++;
      return;
    }

    if (!buf) {
      buf = {
        chunks: [],
        channels,
        flushTimer: null,
        idleTimer: null,
        streamSpeaking: false,
        listening: "passive",
        utterancePeak: 0,
      };
      this.streamBuffers.set(v.clientId, buf);
    }
    buf.channels = channels;
    buf.chunks.push(pcm);

    if (this.isArmed(v.clientId) && isSpeech) {
      this.touchArmedWindow(v.clientId);
      const now = Date.now();
      const lastLog = this.lastArmedInboundLog.get(v.clientId) ?? 0;
      if (now - lastLog >= 250) {
        this.lastArmedInboundLog.set(v.clientId, now);
        this.deps.logger.debug({ clientId: v.clientId, rawPeak }, "Voice: armed inbound speech");
      }
    }

    if (isSpeech) this.scheduleStreamIdle(v.clientId, true);
    else this.scheduleStreamIdle(v.clientId, false);

    const musicPlaying = this.deps.player.getState() === "playing";
    const flushMs = inCapture
      ? this.streamFlushMs
      : musicPlaying
        ? this.passiveMusicFlushMs
        : this.passiveStreamFlushMs;
    if (!buf.flushTimer) {
      buf.flushTimer = setTimeout(() => {
        const active = this.streamBuffers.get(v.clientId);
        if (active) active.flushTimer = null;
        this.enqueueStreamFlush(v.clientId);
      }, flushMs);
    }
  }

  private scheduleStreamIdle(clientId: number, isSpeech: boolean): void {
    const buf = this.streamBuffers.get(clientId);
    if (!buf) return;

    const armed = this.isArmed(clientId);
    const idleMs = armed ? this.armedStreamIdleMs : this.streamIdleMs;

    if (isSpeech) {
      if (buf.idleTimer) clearTimeout(buf.idleTimer);
      buf.idleTimer = setTimeout(() => {
        const active = this.streamBuffers.get(clientId);
        if (active) active.idleTimer = null;
        this.enqueueStreamIdleFinalize(clientId);
      }, idleMs);
      return;
    }

    // Comfort-noise frames must not push idle finalize out forever during a held PTT.
    const shouldFinalize =
      armed ||
      buf.streamSpeaking ||
      !!this.captureDuck ||
      buf.utterancePeak >= VoiceSession.MIN_SPEECH_PEAK;
    if (!shouldFinalize || buf.idleTimer) return;

    buf.idleTimer = setTimeout(() => {
      const active = this.streamBuffers.get(clientId);
      if (active) active.idleTimer = null;
      this.enqueueStreamIdleFinalize(clientId);
    }, idleMs);
  }

  private enqueueStreamIdleFinalize(clientId: number): void {
    const prev = this.streamChains.get(clientId) ?? Promise.resolve();
    const next = prev
      .then(() => this.finalizeStreamIdle(clientId))
      .catch((err) => {
        this.deps.logger.warn({ err, clientId }, "Voice: streaming STT idle finalize failed");
      });
    this.streamChains.set(clientId, next);
  }

  private async finalizeStreamIdle(clientId: number): Promise<void> {
    if (!this.pipeline || !this.sttClient) return;

    const buf = this.streamBuffers.get(clientId);
    if (!buf) return;

    if (buf.chunks.length > 0) {
      await this.flushStreamBuffer(clientId);
    }

    if (!buf.streamSpeaking && !this.captureDuck) return;

    const samples = Math.floor(48_000 * (this.silenceTailMs / 1000));
    const silence = Buffer.alloc(samples * 2);
    const out = await this.sttClient.feedStream(clientId, silence, 48_000, 1);
    this.applyStreamResult(clientId, out, { peak: 0, pcmBytes: silence.length, channels: 1 });

    if (!out.final && this.captureDuck && !this.isArmed(clientId) && !this.anySpeakerArmed()) {
      this.deps.logger.info({ clientId }, "Voice: idle finalize missed — restoring music volume");
      this.abandonCaptureDuck(clientId);
    }
  }

  private enqueueStreamFlush(clientId: number): void {
    const prev = this.streamChains.get(clientId) ?? Promise.resolve();
    const next = prev
      .then(() => this.flushStreamBuffer(clientId))
      .catch((err) => {
        this.deps.logger.warn({ err, clientId }, "Voice: streaming STT flush failed");
      });
    this.streamChains.set(clientId, next);
  }

  private async flushStreamBuffer(clientId: number): Promise<void> {
    if (!this.pipeline || !this.sttClient) return;

    const buf = this.streamBuffers.get(clientId);
    if (!buf || buf.chunks.length === 0) return;

    const channels = buf.channels;
    const inCommand = buf.listening === "command" || this.isArmed(clientId);
    const captureReadyAt = this.commandCaptureReadyAt.get(clientId) ?? 0;

    // Hold buffered PCM until duck settle completes — do not concat/clear early.
    if (inCommand && (Date.now() < captureReadyAt || this.postDuckSettling.has(clientId))) {
      return;
    }

    const pcm = Buffer.concat(buf.chunks);
    buf.chunks = [];
    const rawPeak = peakAmplitude16(pcm);

    if (rawPeak < VoiceSession.MIN_SPEECH_PEAK) {
      return;
    }

    // Loud music still streaming — don't pollute command capture until ducked.
    if (
      inCommand &&
      this.deps.player.getState() === "playing" &&
      !this.deps.player.isSttDucked()
    ) {
      this.deps.logger.debug(
        { clientId },
        "Voice: STT flush held — music not ducked yet",
      );
      return;
    }

    const rawPeakForNorm = peakAmplitude16(pcm);
    const pcmForStt = normalizePcmForStt(pcm, STT_TARGET_PEAK, 120, MIN_PCM_BOOST_PEAK, rawPeakForNorm);
    const peak = rawPeakForNorm < MIN_PCM_BOOST_PEAK ? rawPeakForNorm : peakAmplitude16(pcmForStt);
    buf.utterancePeak = Math.max(buf.utterancePeak, peak);

    const out = await this.sttClient.feedStream(clientId, pcmForStt, 48_000, channels);
    if (this.isArmed(clientId) && rawPeak >= VoiceSession.MIN_SPEECH_PEAK) {
      this.touchArmedWindow(clientId);
      this.deps.logger.debug({ clientId, peak, rawPeak, listening: out.listening }, "Voice: command capture audio");
    }
    this.applyStreamResult(clientId, out, { peak: buf.utterancePeak, pcmBytes: pcm.length, channels });
  }

  private applyStreamResult(
    clientId: number,
    out: StreamSttResult,
    meta: { peak: number; pcmBytes: number; channels: number },
  ): void {
    if (!this.pipeline || !this.sttClient) return;

    const buf = this.streamBuffers.get(clientId);
    if (!buf) return;

    if (out.error && this.captureDuck && !this.isArmed(clientId) && !this.anySpeakerArmed()) {
      this.deps.logger.warn({ clientId, detail: out.error }, "Voice: STT failed — restoring music volume");
      this.abandonCaptureDuck(clientId);
      return;
    }

    const wasSpeaking = buf.streamSpeaking;
    const prevListening = buf.listening;
    const listening = out.listening ?? prevListening;
    buf.listening = listening;
    buf.streamSpeaking = out.speaking;

    if (out.keyword) {
      this.partialRoutedCommand.delete(clientId);
      this.deps.logger.info(
        { clientId, keyword: out.keyword },
        "Voice: KWS wake-word hit — command window open",
      );
      // Extreme duck is tied to KWS only — wake-only "moneypenny" must mute music here.
      this.ensureMusicDuckedOnWake(clientId);
      if (this.isArmed(clientId) && this.captureDuck) this.touchArmedWindow(clientId);
      else this.armSpeaker(clientId);
      if (!out.commandFinal || !out.final) {
        this.deps.logger.info({ clientId, windowMs: this.listenWindowMs }, "Voice: wake only — waiting for command");
      }
    }
    // Do NOT arm on listening==="command" alone. Whisper sidecars used to report
    // command mode while still speaking; that armed without ducking, then blocked
    // further STT flushes while music played (segmentedUtterances stayed 0).

    if (prevListening === "command" && listening === "passive" && !this.isArmed(clientId)) {
      this.deps.logger.info({ clientId }, "Voice: command window closed — restoring music volume");
      this.abandonCaptureDuck(clientId);
    }

    if (
      this.isArmed(clientId) &&
      (out.speaking || out.partial || meta.peak >= VoiceSession.ARMED_ENERGY_THRESHOLD)
    ) {
      this.touchArmedWindow(clientId);
    }

    if (out.partial) {
      const level = this.isArmed(clientId) ? "info" : "debug";
      this.deps.logger[level]({ clientId, partial: out.partial, peak: meta.peak, listening }, "Voice: STT partial");
      if (
        this.isArmed(clientId) &&
        listening === "command" &&
        this.tryRouteArmedPartial(clientId, out.partial, meta)
      ) {
        return;
      }
    }

    if (!out.commandFinal || !out.final) {
      if (
        wasSpeaking &&
        !out.speaking &&
        !out.final &&
        this.captureDuck &&
        !this.isArmed(clientId) &&
        !this.anySpeakerArmed()
      ) {
        this.deps.logger.info({ clientId, peak: meta.peak }, "Voice: command capture ended — restoring music volume");
        this.abandonCaptureDuck(clientId);
      }
      return;
    }

    const silenceTailBytes =
      Math.floor(48_000 * (this.silenceTailMs / 1000)) * 2 * Math.max(1, meta.channels);
    if (meta.peak === 0 && meta.pcmBytes <= silenceTailBytes + 960 && !out.keyword) {
      // Finals often land on the trailing-silence chunk (peak 0).
      // Require a real watchword match (or already-armed) — do NOT invent
      // commands from bare verbs / STT garble (no synonym table).
      const aliases = this.deps.config.commandAliases;
      const armed = this.isArmed(clientId);
      const ww = extractWatchwordCommand(out.final, this.watchword, {
        textWakeFallback: this.textWakeFallback,
        armed,
      });
      if (!ww.matched) {
        this.deps.logger.info(
          { clientId, transcript: out.final },
          "Voice: ignoring silence-tail flush (no watchword / not armed)",
        );
        return;
      }
      const candidate =
        ww.command && isActionableVoiceCommand(ww.command, aliases)
          ? ww.command
          : extractCommandSegment(out.final, this.watchword);
      if (!isActionableVoiceCommand(candidate, aliases)) {
        this.deps.logger.info(
          { clientId, transcript: out.final },
          "Voice: ignoring silence-tail flush (watchword only or no command)",
        );
        // Still allow arm on wake-only via processVoiceTurn below when command empty.
        if (!ww.command?.trim()) {
          // fall through to processVoiceTurn for arm-only
        } else {
          return;
        }
      } else {
        const musicSearch = isMusicSearchRouteText(candidate, aliases);
        if (musicSearch) {
          const parsedArgs = candidate.replace(/^\S+\s*/, "").trim();
          if (!parsedArgs) {
            this.deps.logger.info(
              { clientId, transcript: out.final, command: candidate },
              "Voice: ignoring silence-tail bare play/search (needs title)",
            );
            return;
          }
        } else if (!isPartialSafeVoiceCommand(candidate, aliases) && !armed) {
          // Full wake+command phrases (e.g. clear) are allowed even if not partial-safe.
          // partial-safe is only for bare transport verbs after arm.
        }
        this.deps.logger.info(
          { clientId, transcript: out.final, command: candidate },
          "Voice: silence-tail flush carried a command — routing",
        );
      }
    }

    // Command-mode final — routing/TTS may take several seconds; hold duck until done.
    this.clearDuckWatchdog();

    this.segmentedUtterances++;
    buf.streamSpeaking = false;
    buf.utterancePeak = 0;
    const durationMs = (meta.pcmBytes / 2 / meta.channels / 48_000) * 1000;
    if (!out.final?.trim()) {
      this.deps.logger.info(
        { clientId, peak: meta.peak, durationMs: Math.round(durationMs) },
        "Voice: STT final empty — no route",
      );
      if (this.captureDuck && !this.isArmed(clientId) && !this.anySpeakerArmed()) {
        this.abandonCaptureDuck(clientId);
      }
      return;
    }
    this.deps.logger.info(
      {
        clientId,
        durationMs: Math.round(durationMs),
        peak: meta.peak,
        transcript: out.final,
        keyword: out.keyword,
        commandSource: out.commandSource,
        listening,
      },
      out.commandSource === "kws"
        ? "Voice: command final (KWS) — routing"
        : "Voice: command final — routing",
    );

    const utterance: Utterance = {
      speakerClientId: clientId,
      speakerUid: this.clientInfoCache.get(clientId)?.uid,
      pcm: Buffer.alloc(0),
      sampleRate: 48_000,
      channels: meta.channels,
      durationMs,
    };

    const gen = (this.voiceTurnGen.get(clientId) ?? 0) + 1;
    this.voiceTurnGen.set(clientId, gen);
    const kwsDetected = !!out.keyword;
    void this.processVoiceTurn(clientId, gen, out.final, utterance, kwsDetected);
  }

  private async processVoiceTurn(
    clientId: number,
    gen: number,
    transcript: string,
    utterance: Utterance,
    kwsDetected: boolean,
  ): Promise<void> {
    try {
      const turn = await this.pipeline!.handleTranscript(transcript, utterance, { kwsDetected });
      if (this.voiceTurnGen.get(clientId) !== gen) {
        this.deps.logger.info({ clientId, transcript }, "Voice: stale turn dropped");
        return;
      }
      this.finishVoiceTurn({ reply: turn.reply, watchwordOnly: turn.watchwordOnly }, clientId);
    } catch (err) {
      this.deps.logger.warn({ err, clientId, transcript }, "Voice: handleTranscript failed");
      if (this.voiceTurnGen.get(clientId) === gen) {
        this.finishVoiceTurn({ reply: null, watchwordOnly: false }, clientId);
      }
    }
  }

  private anySpeakerArmed(): boolean {
    for (const clientId of this.armedUntil.keys()) {
      if (this.isArmed(clientId)) return true;
    }
    return false;
  }

  private abandonCaptureDuck(clientId: number): void {
    this.releaseCaptureDuck(clientId);
    void this.sttClient?.resetStream(clientId);
  }

  private isArmed(clientId: number): boolean {
    const until = this.armedUntil.get(clientId);
    if (!until) return false;
    if (Date.now() >= until) {
      this.armedUntil.delete(clientId);
      return false;
    }
    return true;
  }

  private armSpeaker(clientId: number): void {
    this.partialRoutedCommand.delete(clientId);
    this.touchArmedWindow(clientId);
  }

  /**
   * Moonshine often hears "Pause." in partials while silence-tail finals are garbage
   * ("Ours.", "You"). Route actionable verbs immediately while armed.
   */
  private tryRouteArmedPartial(
    clientId: number,
    partial: string,
    meta: { peak: number; pcmBytes: number; channels: number },
  ): boolean {
    const ww = extractWatchwordCommand(partial, this.watchword, { armed: true });
    const candidate = ww.matched && ww.command
      ? ww.command
      : extractCommandSegment(partial, this.watchword);
    if (!isPartialSafeVoiceCommand(candidate, this.deps.config.commandAliases)) return false;
    if (this.partialRoutedCommand.get(clientId) === candidate) return false;
    if (!partialMentionsCommand(partial, candidate)) return false;

    this.partialRoutedCommand.set(clientId, candidate);
    this.clearDuckWatchdog();
    this.segmentedUtterances++;
    const buf = this.streamBuffers.get(clientId);
    if (buf) {
      buf.streamSpeaking = false;
      buf.utterancePeak = 0;
    }

    const durationMs = (meta.pcmBytes / 2 / meta.channels / 48_000) * 1000;
    this.deps.logger.info(
      { clientId, partial, command: candidate, durationMs: Math.round(durationMs) },
      "Voice: armed partial — routing",
    );

    const utterance: Utterance = {
      speakerClientId: clientId,
      speakerUid: this.clientInfoCache.get(clientId)?.uid,
      pcm: Buffer.alloc(0),
      sampleRate: 48_000,
      channels: meta.channels,
      durationMs,
    };

    const gen = (this.voiceTurnGen.get(clientId) ?? 0) + 1;
    this.voiceTurnGen.set(clientId, gen);
    void this.processVoiceTurn(clientId, gen, partial, utterance, false);
    return true;
  }

  /** Extend the post-wake window on speech activity so beat-then-pause doesn't time out. */
  private touchArmedWindow(clientId: number): void {
    this.clearArmTimer(clientId);
    this.armedUntil.set(clientId, Date.now() + this.listenWindowMs);
    const timer = setTimeout(() => {
      this.armTimers.delete(clientId);
      this.armedUntil.delete(clientId);
      this.clearArmedKeepalive(clientId);
      this.clearPostDuckResetTimer(clientId);
      this.commandCaptureReadyAt.delete(clientId);
      this.partialRoutedCommand.delete(clientId);
      this.deps.logger.info({ clientId }, "Voice: armed window expired — restoring music volume");
      void this.sttClient?.resetStream(clientId);
      this.releaseCaptureDuck(clientId);
    }, this.listenWindowMs);
    this.armTimers.set(clientId, timer);
    this.scheduleArmedKeepalive(clientId);
  }

  private schedulePostDuckCaptureReset(clientId: number): void {
    this.clearPostDuckResetTimer(clientId);
    const readyAt = Date.now() + VoiceSession.DUCK_SETTLE_MS;
    this.commandCaptureReadyAt.set(clientId, readyAt);
    const timer = setTimeout(() => {
      this.postDuckResetTimers.delete(clientId);
      if (!this.isArmed(clientId)) {
        this.commandCaptureReadyAt.delete(clientId);
        return;
      }
      // Bot held post-wake PCM during settle — clear sherpa wake bleed, then flush it.
      this.postDuckSettling.add(clientId);
      void (async () => {
        try {
          await this.sttClient?.extendCommandMode(clientId);
          await this.sttClient?.clearCommandBuffer(clientId);
          this.commandCaptureReadyAt.delete(clientId);
          this.deps.logger.info({ clientId }, "Voice: command capture ready after duck settle");
          this.enqueueStreamFlush(clientId);
        } finally {
          this.postDuckSettling.delete(clientId);
        }
      })();
    }, VoiceSession.DUCK_SETTLE_MS);
    this.postDuckResetTimers.set(clientId, timer);
  }

  private clearPostDuckResetTimer(clientId: number): void {
    const timer = this.postDuckResetTimers.get(clientId);
    if (timer) clearTimeout(timer);
    this.postDuckResetTimers.delete(clientId);
  }

  private scheduleArmedKeepalive(clientId: number): void {
    if (this.armedKeepaliveTimers.has(clientId)) return;
    const timer = setInterval(() => {
      if (!this.isArmed(clientId)) {
        this.clearArmedKeepalive(clientId);
        return;
      }
      void this.sttClient?.extendCommandMode(clientId);
    }, 3000);
    this.armedKeepaliveTimers.set(clientId, timer);
  }

  private clearArmedKeepalive(clientId: number): void {
    const timer = this.armedKeepaliveTimers.get(clientId);
    if (timer) clearInterval(timer);
    this.armedKeepaliveTimers.delete(clientId);
  }

  private disarmSpeaker(clientId: number): void {
    this.clearArmTimer(clientId);
    this.clearArmedKeepalive(clientId);
    this.clearPostDuckResetTimer(clientId);
    this.commandCaptureReadyAt.delete(clientId);
    this.partialRoutedCommand.delete(clientId);
    this.armedUntil.delete(clientId);
  }

  private isPlayInFlight(clientId: number): boolean {
    const until = this.playInFlightUntil.get(clientId);
    if (!until) return false;
    if (Date.now() >= until) {
      this.playInFlightUntil.delete(clientId);
      return false;
    }
    return true;
  }

  private markPlayInFlight(clientId: number, query: string): void {
    this.playInFlightUntil.set(clientId, Date.now() + VoiceSession.PLAY_IN_FLIGHT_MS);
    this.deps.logger.info({ clientId, query }, "Voice: play resolve marked in-flight");
  }

  private clearPlayInFlight(clientId: number): void {
    this.playInFlightUntil.delete(clientId);
  }

  private clearArmTimer(clientId: number): void {
    const timer = this.armTimers.get(clientId);
    if (timer) clearTimeout(timer);
    this.armTimers.delete(clientId);
  }

  private clearAllArmTimers(): void {
    for (const timer of this.armTimers.values()) clearTimeout(timer);
    this.armTimers.clear();
    for (const clientId of this.armedKeepaliveTimers.keys()) this.clearArmedKeepalive(clientId);
    for (const clientId of this.postDuckResetTimers.keys()) this.clearPostDuckResetTimer(clientId);
    this.commandCaptureReadyAt.clear();
    this.postDuckSettling.clear();
    this.armedUntil.clear();
  }

  /**
   * Mute bot music the instant sherpa KWS spots the wake word.
   * Wake-only ("moneypenny" with no command) still hits this path via out.keyword.
   * No duck on command-mode audio alone — music must keep playing until KWS fires.
   */
  private ensureMusicDuckedOnWake(clientId: number): void {
    if (!this.duckMusicOnSpeech) return;
    if (this.deps.player.getState() !== "playing") {
      // Idle channel is common — do not spam info logs on every wake.
      this.deps.logger.debug(
        { clientId, state: this.deps.player.getState() },
        "Voice: wake duck skipped — player not playing",
      );
      return;
    }

    const currentSong = this.deps.queue.current();
    if (!currentSong) return;

    if (this.captureDuck && !this.deps.player.isSttDucked()) {
      this.deps.logger.warn({ clientId }, "Voice: stale captureDuck without active duck — re-applying");
    }

    if (!this.deps.player.duckForStt(this.duckMusicVolume)) {
      this.deps.logger.warn(
        {
          clientId,
          state: this.deps.player.getState(),
          volume: this.deps.player.getVolume(),
          duckLevel: this.duckMusicVolume,
        },
        "Voice: failed to duck music on wake",
      );
      return;
    }

    if (!this.captureDuck) {
      const elapsed = Math.floor(this.deps.player.getElapsed?.() ?? 0);
      this.captureDuck = { song: currentSong, elapsed };
      this.captureDuckClientId = clientId;
      this.schedulePostDuckCaptureReset(clientId);
      this.scheduleDuckWatchdog(clientId);
    }

    this.deps.logger.info(
      {
        clientId,
        elapsed: this.captureDuck?.elapsed,
        userVolume: this.deps.player.getVolume(),
        duckLevel: this.duckMusicVolume,
      },
      "Voice: ducked music on wake",
    );
  }

  private scheduleDuckWatchdog(clientId: number): void {
    this.clearDuckWatchdog();
    this.duckWatchdog = setTimeout(() => {
      this.duckWatchdog = null;
      if (!this.captureDuck) return;
      if (this.anySpeakerArmed()) return;
      this.deps.logger.warn({ clientId }, "Voice: duck watchdog — restoring music volume");
      this.abandonCaptureDuck(clientId);
    }, this.duckWatchdogMs);
  }

  private clearDuckWatchdog(): void {
    if (this.duckWatchdog) clearTimeout(this.duckWatchdog);
    this.duckWatchdog = null;
  }

  /** Resume or hand off duck state after each voice turn. */
  private finishVoiceTurn(
    turn: { reply: string | null; watchwordOnly: boolean },
    clientId: number,
  ): void {
    if (turn.watchwordOnly) {
      this.deps.logger.info(
        { clientId, windowMs: this.listenWindowMs },
        "Voice: holding music ducked — armed for follow-up",
      );
      return;
    }
    this.finishCaptureDuck(turn.reply, clientId);
  }

  /** Restore pre-duck volume and clear captureDuck (arm expiry, abandoned duck, or turn complete). */
  private releaseCaptureDuck(clientId?: number): void {
    const hadCapture = !!this.captureDuck;
    this.captureDuck = null;
    this.captureDuckClientId = null;
    this.clearDuckWatchdog();
    if (clientId !== undefined) {
      this.resetStreamListeningState(clientId);
    }
    if (this.deps.player.isSttDucked()) {
      this.deps.player.restoreFromSttDuck();
      this.deps.logger.info("Voice: restored music volume after duck");
    } else if (hadCapture) {
      this.deps.logger.warn("Voice: captureDuck cleared but STT duck was not active");
    }
  }

  /** Drop mirrored command-mode state so passive KWS can receive audio again. */
  private resetStreamListeningState(clientId: number): void {
    const buf = this.streamBuffers.get(clientId);
    if (!buf) return;
    buf.listening = "passive";
    buf.chunks = [];
    buf.utterancePeak = 0;
    buf.streamSpeaking = false;
  }

  /** Release duck after a routed command unless playback intentionally changed. */
  private finishCaptureDuck(reply: string | null, clientId: number): void {
    // speak() may already have moved captureDuck → savedMusic before this runs.
    if (reply && isPlaybackStartReply(reply)) {
      this.disarmSpeaker(clientId);
      this.releaseCaptureDuck(clientId);
      void this.sttClient?.resetStream(clientId);
      this.deps.logger.info({ clientId, reply }, "Voice: playback started — disarmed for next wake");
      return;
    }

    if (reply && isPlaybackControlReply(reply)) {
      // Pause/resume/skip must end the armed window — otherwise flushStreamBuffer
      // keeps treating inbound audio as command capture and drops it while music
      // plays at full volume (no duck), so the next "moneypenny" never reaches KWS.
      this.disarmSpeaker(clientId);
      this.releaseCaptureDuck(clientId);
      void this.sttClient?.resetStream(clientId);
      this.deps.logger.info({ clientId, reply }, "Voice: playback command done — disarmed for next wake");
      if (voiceReplyClearsSavedMusic(reply)) {
        this.savedMusic = null;
        this.suppressNextTrackAdvance = true;
      }
      return;
    }

    if (!this.captureDuck) return;
    if (this.savedMusic) {
      this.captureDuck = null;
      this.captureDuckClientId = null;
      this.clearDuckWatchdog();
      return;
    }

    // STT miss or non-pause command while still armed — keep music ducked for retry.
    if (this.isArmed(clientId)) {
      this.deps.logger.info({ clientId }, "Voice: follow-up inconclusive — keeping music ducked while armed");
      return;
    }

    this.releaseCaptureDuck(clientId);
  }

  private logDecodeFailure(clientId: number, opusBytes: number): void {
    const count = (this.decodeFailuresByClient.get(clientId) ?? 0) + 1;
    this.decodeFailuresByClient.set(clientId, count);
    if (count <= 3 || count % 50 === 0) {
      this.deps.logger.warn(
        { clientId, codec: CODEC_OPUS_VOICE, opusBytes, count },
        "Voice: opus decode failed",
      );
    }
  }

  private logInboundStats(): void {
    const now = Date.now();
    if (now - this.lastStatsAt < 10_000) return;
    this.lastStatsAt = now;
    const decodeFailures = Object.fromEntries(this.decodeFailuresByClient);
    this.deps.logger.info(
      {
        inboundPackets: this.inboundPackets,
        decodedFrames: this.decodedFrames,
        segmentedUtterances: this.segmentedUtterances,
        speakers: this.streamBuffers.size,
        droppedNonVoiceCodec: this.droppedNonVoiceCodec,
        droppedSelfEcho: this.droppedSelfEcho,
        droppedPassiveDtx: this.droppedPassiveDtx,
        skippedPassiveComfortNoise: this.skippedPassiveComfortNoise,
        skippedPassiveSpeakerCap: this.skippedPassiveSpeakerCap,
        passiveKwsMaxSpeakers: this.passiveKwsMaxSpeakers,
        passiveKwsRanked: this.rankedPassiveSpeakers().length,
        attenuatedClipped: this.attenuatedClipped,
        multiFrameRecoveries: this.multiFrameRecoveries,
        decodeFailures,
      },
      "Voice: inbound capture stats",
    );
  }

  private async buildContext(u: Utterance): Promise<RouterContext> {
    const subject = await this.resolveSubject(u.speakerClientId);
    u.speakerUid = subject.uid;
    const engine = this.deps.rightsEngine();
    const canRun = engine ? (cmd: string) => engine.can(subject, cmd, "voice") : undefined;
    return {
      bot: this.deps.bot,
      logger: this.deps.logger,
      conversationId: `voice:${subject.uid}`,
      canRun,
      allowedClassifications: allowedClassificationsFor(subject, engine),
      invokerUid: subject.uid,
      invokerName: subject.nickname,
      message: {
        invokerName: subject.nickname ?? "",
        invokerId: String(u.speakerClientId),
        invokerUid: subject.uid,
        invokerGroups: subject.serverGroups,
        message: "",
        targetMode: 2,
      },
      postFollowUp: async (text) => {
        await this.deps.tsClient.sendTextMessage(text);
      },
    };
  }

  /**
   * Prefer idle-poll clientInfoCache when groups are present; fall back to live
   * resolve (HTTP group enrich) on miss / empty groups so rank gating stays correct.
   */
  private async resolveSubject(clid: number): Promise<Subject> {
    const cached = this.clientInfoCache.get(clid);
    if (cached?.uid && cached.serverGroups.length > 0) {
      return {
        uid: cached.uid,
        serverGroups: cached.serverGroups,
        nickname: cached.nickname,
      };
    }
    return resolveRightsSubject(
      cached?.uid ?? `client:${clid}`,
      this.deps.tsClient,
      this.deps.logger,
      cached?.serverGroups,
      clid,
    );
  }

  private createOutput(): VoiceOutput {
    return {
      speak: async (audio: Buffer, format: string) => {
        if (!this.deps.isConnected()) return;
        if (!this.tempDir) this.tempDir = mkdtempSync(join(tmpdir(), "moneypenny-tts-"));
        const file = join(this.tempDir, `reply.${format}`);
        writeFileSync(file, audio);
        if (this.captureDuck) {
          this.deps.player.restoreFromSttDuck();
          this.savedMusic = this.captureDuck;
          this.captureDuck = null;
          this.captureDuckClientId = null;
          this.clearDuckWatchdog();
        } else {
          const currentSong = this.deps.queue.current();
          if (currentSong) {
            const elapsed = Math.floor(this.deps.player.getElapsed?.() ?? 0);
            this.savedMusic = { song: currentSong, elapsed };
          }
        }
        this.deps.player.resetFailures();
        this.deps.player.play(file);
        setTimeout(() => {
          try { rmSync(file, { force: true }); } catch { /* ignore */ }
        }, 3000);
      },
    };
  }
}