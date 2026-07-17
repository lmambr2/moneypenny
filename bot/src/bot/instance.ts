import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname, isAbsolute, join } from "node:path";
import { AudioPlayer } from "../audio/player.js";
import { type PlayMode, PlayQueue, type QueuedSong } from "../audio/queue.js";
import { registerBotCommandHandlers } from "../control/register-handlers.js";
import { ControlRouter } from "../control/router.js";
import type { AvatarStore } from "../data/avatars.js";
import type { BotConfig } from "../data/config.js";
import type { BotDatabase } from "../data/database.js";
import type { DoctrineStore } from "../data/doctrine.js";
import type { FileDropStore } from "../data/file-drop.js";
import { KgStore } from "../data/kg.js";
import { MemoryStore } from "../data/memory.js";
import { RoastStore } from "../data/roast.js";
import type { WorkflowKind } from "../docs/workflow.js";
import { startEconomyCacheScheduler } from "../economy/cache/refresh.js";
import { initEconomyDiskCache } from "../economy/cache/store.js";
import { initWorkOrderStore } from "../economy/work-orders.js";
import type { Logger } from "../logger.js";
import { MemPalaceClient } from "../memory/mempalace-client.js";
import { buildScopesSnapshot } from "../memory/scopes.js";
import { AceStepClient } from "../music/ace-step-client.js";
import { GenerateProvider } from "../music/generate-provider.js";
import type { LocalProvider } from "../music/local.js";
import type { MusicProvider } from "../music/provider.js";
import { StreamProvider } from "../music/stream.js";
import {
  audioColorFilter,
  BumperCache,
  floorFromMembers,
  IcecastTee,
  PrerecordedPool,
  type PresentMember,
  parseAudioColorPreset,
  RadioBumperFactory,
  RadioDirector,
  RelayScheduler,
  SpeechSink,
  TagStore,
} from "../radio/index.js";
import { DEFAULT_EVAL_CASES, type EvalCase, runEvalLoop } from "../rag/eval-loop.js";
import type { RetrievalStore } from "../rag/index.js";
import type { RightsConfig } from "../rights/index.js";
import {
  createHostHealthPlugin,
  createStarCitizenOrgStatusPlugin,
  ExternalStatusRegistry,
} from "../tools/external-status.js";
import { TS3Client, type TS3ClientOptions, type TS3TextMessage } from "@moneypenny/ts6-client";
import { KokoroTtsClient, type TtsProvider } from "../voice/index.js";
import { defaultVoiceConfig, type VoiceConfig } from "../voice/types.js";
import {
  defaultUnderMusicConfig,
  runUnderMusicSmoke,
  type UnderMusicConfig,
} from "../voice/under-music.js";
import { CommandExecutor } from "./commands/executor.js";
import type { ParsedCommand } from "./commands.js";
import { KgService } from "./community/kg.js";
import { MemoryService } from "./community/memory.js";
import { OpsService } from "./community/ops.js";
import { RoastService } from "./community/roast.js";
import { PokeHandler } from "./control/poke-handler.js";
import { RoutedCommandExecutor } from "./control/routed-executor.js";
import { TextMessageHandler } from "./control/text-handler.js";
import { createYtLibrary } from "./factory/yt-library.js";
import { KnowledgeService } from "./knowledge/service.js";
import { bindPlayerEvents, bindTsEvents } from "./lifecycle/event-bindings.js";
import { countChannelHumans, IdlePoller } from "./lifecycle/idle-poller.js";
import { schedulePhase0AutoPlay } from "./lifecycle/phase0.js";
import { LlmRuntime } from "./llm/runtime.js";
import { PlaybackEngine } from "./playback/engine.js";
import { BotProfileManager } from "./profile.js";
import { RightsRuntime } from "./rights/runtime.js";
import { allowedClassificationsFor } from "./rights/subject.js";
import { VoiceSession } from "./voice/session.js";

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
  /** Shared radio tag overlay (one per process); constructed here if absent. */
  tagStore?: TagStore;
  /** Admin playback ban list (shared; optional). */
  playbackBlacklist?: import("../music/playback-blacklist.js").PlaybackBlacklist;
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
  elapsed: number;
}

/** TeamSpeak bot orchestrator — wires subsystems; execution lives in submodules. */
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
  private playback: PlaybackEngine;
  private commands: CommandExecutor;
  private roast: RoastService;
  private memory: MemoryService;
  private kg: KgService;
  private ops: OpsService;
  private statusRegistry: ExternalStatusRegistry;
  private knowledge: KnowledgeService;
  private llm: LlmRuntime;
  private idlePoller: IdlePoller;
  private radio: RadioDirector;
  private bumperFactory: RadioBumperFactory;
  private bumperCache: BumperCache;
  private text: TextMessageHandler;
  private poke: PokeHandler;
  private rights: RightsRuntime;
  private routed: RoutedCommandExecutor;
  private mempalace: MemPalaceClient | null = null;
  private harnessStore: import("../harness/index.js").HarnessTurnStore | null = null;
  private aceStep: AceStepClient | null = null;
  private generateProvider: GenerateProvider;
  private icecastTee: IcecastTee;
  private relayScheduler: RelayScheduler;
  private voice: VoiceSession;
  private connected = false;
  private disconnectEmitted = false;
  /** Monotonic guard so an older getClientsInChannel reply can't overwrite a newer count. */
  private presenceSyncEpoch = 0;
  /**
   * Set when disconnect() is invoked by us (stop/restart). Remote drops leave this
   * false so BotManager can event-reconnect (S-OC3).
   */
  private localDisconnect = false;
  private isAdvancing = false;
  private profileManager: BotProfileManager;
  private controlRouter: ControlRouter;

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

    const roastStore = new RoastStore(this.database.db);
    const memoryStore = new MemoryStore(this.database.db);
    const kgStore = new KgStore(this.database.db);
    const radioTagStore = options.tagStore ?? new TagStore({ db: this.database.db });
    const ytLibrary = createYtLibrary({
      db: this.database.db,
      localProvider: this.localProvider,
      youtubeProvider: this.youtubeProvider,
      logger: this.logger,
    });

    this.tsClient = new TS3Client(options.tsOptions, this.logger);
    const rc = options.config.reconnect;
    if (rc) {
      this.tsClient.configureVoiceTransportHealth({
        threshold: rc.voiceErrorThreshold,
        windowMs: rc.voiceErrorWindowMs,
        healthyReset: rc.voiceHealthyReset,
      });
    }
    this.player = new AudioPlayer(this.logger);
    this.queue = new PlayQueue();

    const profileConfig = this.database.getProfileConfig(this.id);
    this.profileManager = new BotProfileManager(
      this.tsClient,
      this.logger,
      profileConfig,
      options.tsOptions.nickname,
    );

    this.knowledge = new KnowledgeService({
      config: this.config,
      logger: this.logger,
      tsClient: this.tsClient,
      localProvider: this.localProvider,
      isConnected: () => this.connected,
    });

    this.controlRouter = new ControlRouter(this.logger, undefined);
    this.controlRouter.setClarifyOnceEnabled(this.config.intentClarifyOnce === true);

    this.rights = new RightsRuntime({
      config: this.config,
      logger: this.logger,
      tsClient: this.tsClient,
    });
    this.rights.initialize();

    this.mempalace = this.createMemPalaceClient();
    this.aceStep = this.createAceStepClient();
    this.generateProvider = new GenerateProvider({
      getConfig: () => this.config,
      getClient: () => this.aceStep,
      localProvider: this.localProvider as LocalProvider,
      tagStore: radioTagStore,
      logger: this.logger,
      playSong: async (song) =>
        this.playback.playResolvedItem({ type: "song", item: song }, "local"),
      getPlayingPath: async () => {
        const cur = this.queue.current();
        if (cur?.platform !== "local") return null;
        try {
          return (await (this.localProvider as LocalProvider).pathForId(cur.id)) ?? null;
        } catch {
          return null;
        }
      },
    });

    this.kg = new KgService({
      store: kgStore,
      config: this.config,
      mempalace: this.mempalace,
      logger: this.logger,
    });

    this.statusRegistry = new ExternalStatusRegistry();
    this.statusRegistry.register(createHostHealthPlugin());
    this.refreshScOrgPlugin();
    this.ops = new OpsService({
      statusRegistry: this.statusRegistry,
      getNowPlaying: () => {
        const cur = this.queue.current();
        return cur ? `${cur.name}${cur.artist ? ` — ${cur.artist}` : ""}` : null;
      },
      getRadioStatus: async () => {
        const r = this.config.radio;
        if (!r?.enabled) return "Radio: off";
        return `Radio: on · profile ${r.activeProfile} · everyN ${r.everyNSongs}`;
      },
      getOrgBrief: async () => {
        if (!this.config.kgEnabled) return "";
        const facts = this.kg.listFacts(3);
        if (facts.length === 0) return "Org KG: (empty — !kg remember <fact>)";
        return `Org KG: ${facts.map((f) => f.fact).join("; ")}`;
      },
      getScMembers: async () => {
        const { ScOrgClient } = await import("../tools/sc-org-client.js");
        const base = (this.config.scOrgStatusUrl || process.env.SC_ORG_STATUS_URL || "").trim();
        if (!base) return "○ SC members: not configured (set SC org status URL).";
        try {
          const client = new ScOrgClient({
            baseUrl: base,
            orgName: this.config.scOrgName || undefined,
          });
          const members = await client.getMembers();
          if (members.length === 0) return "○ SC members: (empty list from bridge).";
          const online = members.filter((m) => m.online);
          const lines = members
            .slice(0, 12)
            .map((m) => `${m.online ? "●" : "○"} ${m.name}${m.rank ? ` (${m.rank})` : ""}`);
          return `SC members (${online.length} online / ${members.length}):\n${lines.join("\n")}`;
        } catch (err) {
          return `○ SC members unavailable (${err instanceof Error ? err.message : String(err)}).`;
        }
      },
      getScFleet: async () => {
        const { ScOrgClient } = await import("../tools/sc-org-client.js");
        const base = (this.config.scOrgStatusUrl || process.env.SC_ORG_STATUS_URL || "").trim();
        if (!base) return "○ SC fleet: not configured (set SC org status URL).";
        try {
          const client = new ScOrgClient({
            baseUrl: base,
            orgName: this.config.scOrgName || undefined,
          });
          const fleet = await client.getFleet();
          if (fleet.vessels.length === 0) {
            return fleet.summary
              ? `SC fleet: ${fleet.summary}`
              : "○ SC fleet: (empty from bridge).";
          }
          const lines = fleet.vessels
            .slice(0, 12)
            .map((v) => `· ${v.name}${v.role ? ` — ${v.role}` : ""}`);
          return [`SC fleet${fleet.summary ? `: ${fleet.summary}` : ""}`, ...lines].join("\n");
        } catch (err) {
          return `○ SC fleet unavailable (${err instanceof Error ? err.message : String(err)}).`;
        }
      },
    });

    this.llm = new LlmRuntime({
      config: this.config,
      logger: this.logger,
      memoryStore,
      getKg: () => this.kg,
      getMemPalace: () => this.mempalace,
      getRetrieval: () => this.knowledge.getRetrieval(),
      getRightsEngine: () => this.rights.getEngine(),
      onModuleChange: (module) => this.controlRouter.setLlm(module ?? undefined),
    });
    this.llm.initialize();

    this.playback = new PlaybackEngine({
      botId: this.id,
      player: this.player,
      queue: this.queue,
      localProvider: this.localProvider,
      youtubeProvider: this.youtubeProvider,
      streamProvider: this.streamProvider,
      ytLibrary,
      database: this.database,
      config: this.config,
      profileManager: this.profileManager,
      logger: this.logger,
      events: this,
      isConnected: () => this.connected,
      isAdvancing: () => this.isAdvancing,
      setAdvancing: (v) => {
        this.isAdvancing = v;
      },
      playbackBlacklist: options.playbackBlacklist,
    });

    this.icecastTee = new IcecastTee({
      logger: this.logger,
      spawn: (cmd, args, opts) => {
        const child = nodeSpawn(cmd, args, {
          stdio: (opts?.stdio as ("pipe" | "ignore")[] | undefined) ?? ["pipe", "ignore", "pipe"],
        });
        return {
          stdin: child.stdin
            ? {
                write: (b: Buffer) => child.stdin!.write(b),
                end: () => {
                  child.stdin!.end();
                },
              }
            : null,
          killed: child.killed,
          kill: (sig?: string | number) => child.kill(sig as NodeJS.Signals | undefined),
          on: (ev: string, cb: (...a: unknown[]) => void) => {
            child.on(ev, cb);
          },
        };
      },
    });
    this.relayScheduler = new RelayScheduler({
      onBumper: async () => {
        try {
          await this.radio.cueBumper("relay");
        } catch (err) {
          this.logger.warn({ err }, "relay timer bumper failed");
        }
      },
      logger: this.logger,
    });
    // Apply optional Icecast tee from config (default off).
    this.icecastTee.apply(this.config.radio?.icecast ?? null);
    this.applyAudioColor(this.config.radio?.audioColor);

    this.commands = new CommandExecutor({
      playback: this.playback,
      player: this.player,
      queue: this.queue,
      config: this.config,
      profileManager: this.profileManager,
      tsClient: this.tsClient,
      isConnected: () => this.connected,
      playNext: (n) => this.playNext(n),
      getProvider: (flags, q) => this.playback.pickProvider(flags, q),
      tagStore: radioTagStore,
      playbackBlacklist: options.playbackBlacklist,
      database: this.database,
      botId: this.id,
      // Lazy delegate — the director is constructed a few steps below.
      radio: {
        cueBumper: (topic) => this.radio.cueBumper(topic),
        cueSay: (text) => this.radio.cueSay(text),
        skipBumper: () => this.radio.skipBumper(),
        getLastPlayedBumper: () => this.radio.getLastPlayedBumper(),
        onTrackBoundary: () => this.radio.onTrackBoundary(),
        status: () => this.radio.status(),
      },
      speakRadioStatus: () => this.speakRadioStatus(),
      getBumperDir: () => this.resolveBumperDir(dirname(this.database.db.name)),
      prewarmRadioBumpers: (opts) => this.prewarmRadioBumpers(opts),
      generateProvider: this.generateProvider,
      logger: this.logger,
      onRelayChanged: (cfg) => {
        // start(null) fully stops (clears cfg + generation so in-flight fire cannot re-arm).
        this.relayScheduler.start(cfg);
      },
    });

    this.roast = new RoastService({
      store: roastStore,
      config: this.config,
      llm: () => this.llm.getModule(),
      tsClient: this.tsClient,
      logger: this.logger,
    });

    this.memory = new MemoryService({
      store: memoryStore,
      config: this.config,
      mempalace: this.mempalace,
      logger: this.logger,
    });

    // === Radio / autonomous DJ (docs/radio.md R-R1) ===
    // Always constructed so hot-reloading radio.enabled needs no re-init; the
    // director short-circuits to playNext() while disabled (byte-identical).
    // Bumpers live under the data dir (dirname of the sqlite file) — NOT under
    // MUSIC_DIR, so prerecorded assets are never indexed as songs.
    const dataDir = dirname(this.database.db.name);
    // Economy API SQLite cache (UEX / sc-craft / sc-trade / sc-wiki) + scheduled refresh.
    // Prefer shared init from index.ts; re-bind if this process path skipped boot init.
    try {
      initEconomyDiskCache({ db: this.database.db, dataDir });
      startEconomyCacheScheduler({ logger: this.logger });
      initWorkOrderStore(this.database.db);
    } catch (err) {
      this.logger.warn({ err }, "economy disk cache / work orders init skipped");
    }
    const radioBumperDir = this.resolveBumperDir(dataDir);
    const radioTtsVoice = this.config.radio.ttsVoice ?? this.config.voice.ttsVoice;
    const radioTts: TtsProvider = this.config.voice.ttsUrl
      ? new KokoroTtsClient({
          url: this.config.voice.ttsUrl,
          voice: radioTtsVoice,
          logger: this.logger,
        })
      : { synthesize: () => Promise.reject(new Error("TTS not configured")) };
    this.bumperCache = new BumperCache({
      db: this.database.db,
      cacheDir: join(dataDir, "bumper-cache"),
      logger: this.logger,
    });
    const speechSink = new SpeechSink({
      tts: radioTts,
      cache: this.bumperCache,
      logger: this.logger,
      voice: radioTtsVoice,
      player: this.player,
    });
    this.bumperFactory = new RadioBumperFactory({
      getConfig: () => this.config.radio,
      prerecorded: new PrerecordedPool({ dir: radioBumperDir, logger: this.logger }),
      speech: speechSink,
      getNowPlaying: () => {
        const cur = this.queue.current();
        return cur ? { previous: { name: cur.name, artist: cur.artist } } : {};
      },
      // Bumper-flagged library assets for the active profile (§9.2); trackKey is
      // LocalProvider's opaque id, so getSongUrl resolves it (search hides these,
      // getSongUrl doesn't). Falls back to the prerecorded dir pool.
      getBumperAsset: async () => {
        const keys = radioTagStore.bumperKeys(this.config.radio.activeProfile);
        if (keys.length === 0) return null;
        const key = keys[Math.floor(Math.random() * keys.length)];
        return this.localProvider.getSongUrl(key);
      },
      stationName: this.name,
      getRetrieval: () => this.knowledge.getRetrieval() ?? null,
      getLlm: () => this.llm.getModule() ?? null,
      // OQ1: org KG / diary only — never per-user !remember rooms.
      // Prefer MemPalace kgSearch; fall back to SQLite org KG (never private rooms).
      getOrgMemory: () => {
        if (!this.config.kgEnabled && !this.config.mempalaceEnabled) return null;
        return {
          searchOrg: async (query: string, limit = 5) => this.kg.searchOrg(query, limit),
        };
      },
      logger: this.logger,
    });
    this.radio = new RadioDirector({
      getConfig: () => this.config.radio,
      player: this.player,
      bumperFactory: this.bumperFactory,
      playNext: () => this.playNext(),
      autoProgram: () => this.commands.autoProgramRadio(),
      // Alone (0 humans / only bot) → stop + clear; human joins → resume.
      stopForEmptyChannel: () => {
        this.player.stop();
        this.queue.clear();
      },
      // §6.3: broadcast floor = intersection of every present member's clearance
      // (idle-poller ClientInfo: uid + serverGroups; the bot itself is skipped).
      resolveFloor: (clients) => {
        const engine = this.rights.getEngine();
        if (!engine) return ["unclassified"];
        return floorFromMembers(clients as PresentMember[], (subject) =>
          allowedClassificationsFor(subject, engine),
        );
      },
      // Refresh humans before each bumper decision (!skip / trackEnd).
      refreshPresence: async () => {
        await this.syncRadioChannelPresence();
      },
      logger: this.logger,
    });

    this.idlePoller = new IdlePoller({
      config: this.config,
      logger: this.logger,
      tsClient: this.tsClient,
      isConnected: () => this.connected,
      onDisconnect: () => this.disconnect(),
      onPoll: (clients, userCount) => {
        this.voice.refreshClientCache(clients);
        // Backup reconcile if a move notify was missed.
        this.radio.onPoll(clients, userCount);
        if (this.config.roastEnabled) {
          this.roast.runTick(userCount).catch(() => {});
        }
      },
    });

    // HoneyBBQ: clientEnter / clientLeave / clientMoved → recount + alone-stop.
    const onMembershipChange = () => {
      void this.syncRadioChannelPresence();
    };
    this.tsClient.on("clientEnter", onMembershipChange);
    this.tsClient.on("clientLeave", onMembershipChange);
    this.tsClient.on("clientMoved", onMembershipChange);

    // Voice packets: bumper minPresent backup only (not alone-stop).
    this.tsClient.on("voiceData", (v: { clientId?: number }) => {
      const clid = Number(v?.clientId);
      if (Number.isFinite(clid) && clid > 0 && clid !== this.tsClient.getClientId()) {
        this.radio.noteHumanActivity(clid);
      }
    });

    this.text = new TextMessageHandler({
      bot: this,
      config: this.config,
      logger: this.logger,
      tsClient: this.tsClient,
      router: this.controlRouter,
      roast: this.roast,
      llm: this.llm,
      rightsEngine: () => this.rights.getEngine(),
    });

    this.poke = new PokeHandler({
      bot: this,
      config: this.config,
      logger: this.logger,
      tsClient: this.tsClient,
      router: this.controlRouter,
      llm: this.llm,
      rightsEngine: () => this.rights.getEngine(),
    });

    this.voice = new VoiceSession({
      config: this.config,
      logger: this.logger,
      tsClient: this.tsClient,
      player: this.player,
      queue: this.queue,
      router: this.controlRouter,
      bot: this,
      rightsEngine: () => this.rights.getEngine(),
      getProviderFor: (p) => this.playback.getProviderFor(p),
      isConnected: () => this.connected,
      onClientList: () => {},
    });

    this.routed = new RoutedCommandExecutor({
      bot: this,
      router: this.controlRouter,
      rights: this.rights,
      tsClient: this.tsClient,
      logger: this.logger,
      adminGroups: () => (this.config.adminGroups ?? []).map(String),
    });

    if (this.config.voice?.enabled) {
      this.voice.enable();
    }

    registerBotCommandHandlers(this.controlRouter, {
      commands: this.commands,
      playback: this.playback,
      roast: this.roast,
      memory: this.memory,
      kg: this.kg,
      ops: this.ops,
      moderation: (action, target, canRun) => this.moderationAction(action, target, canRun),
      knowledge: this.knowledge,
      generate: {
        handleGenerate: (args, invokerKey) =>
          this.generateProvider.handleGenerate(args, invokerKey),
      },
    });

    try {
      const relPath = this.database.getCustomAvatarPath(this.id);
      if (relPath) {
        const buf = this.avatarStore.read(relPath);
        if (buf) this.profileManager.setCustomAvatar(buf);
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to load custom avatar — skipping");
    }

    bindPlayerEvents({
      player: this.player,
      tsClient: this.tsClient,
      voice: this.voice,
      radio: this.radio,
      logger: this.logger,
      playNext: () => this.playNext(),
      // R-R6: same program PCM that becomes Opus for TS → Icecast when enabled.
      onPcm: (pcm) => this.teeIcecastPcm(pcm),
    });

    bindTsEvents({
      tsClient: this.tsClient,
      text: this.text,
      poke: this.poke,
      idlePoller: this.idlePoller,
      knowledge: this.knowledge,
      player: this.player,
      voice: this.voice,
      logger: this.logger,
      setConnected: (v) => {
        this.connected = v;
      },
      isDisconnectEmitted: () => this.disconnectEmitted,
      setDisconnectEmitted: (v) => {
        this.disconnectEmitted = v;
      },
      emitDisconnected: () => this.emit("disconnected"),
      onVoiceTransportUnhealthy: () => this.emit("voiceTransportUnhealthy"),
    });
  }

  async connect(): Promise<void> {
    this.disconnectEmitted = false;
    this.localDisconnect = false;
    await this.tsClient.connect();
    if (this.disconnectEmitted) {
      throw new Error("Connect aborted by concurrent disconnect");
    }
    this.connected = true;
    this.profileManager.onConnect();
    this.emit("connected");

    schedulePhase0AutoPlay({
      logger: this.logger,
      executeCommand: (cmd) => this.executeCommand(cmd),
    });
  }

  /**
   * True when the last disconnect was initiated by `disconnect()` (stop/restart),
   * not a remote/network drop. Consumed once by the manager reconnect path.
   */
  consumeLocalDisconnect(): boolean {
    const v = this.localDisconnect;
    this.localDisconnect = false;
    return v;
  }

  disconnect(): void {
    this.localDisconnect = true;
    this.idlePoller.stop();
    this.knowledge.stopFileDropWatcher();
    this.player.stop();
    this.voice.cleanup();
    this.radio.dispose();
    this.relayScheduler.stop();
    this.icecastTee.stop();
    this.connected = false;
    if (!this.disconnectEmitted) {
      this.disconnectEmitted = true;
      this.emit("disconnected");
    }
    this.tsClient.disconnect();
  }

  updateIdleTimeout(minutes: number): void {
    this.idlePoller.updateIdleTimeout(minutes);
  }

  updateLlm(
    enabled: boolean,
    url?: string,
    model?: string,
    systemPrompt?: string,
    temperature?: number,
    fallbackUrl?: string,
    fallbackModel?: string,
    delegateUrl?: string,
    delegateModel?: string,
  ): void {
    this.llm.updateLlm(
      enabled,
      url,
      model,
      systemPrompt,
      temperature,
      fallbackUrl,
      fallbackModel,
      delegateUrl,
      delegateModel,
    );
  }

  setRetrieval(store: RetrievalStore | undefined): void {
    this.knowledge.setRetrieval(store);
    this.llm.refreshRetrieveHook();
  }

  setDoctrine(store: DoctrineStore | undefined): void {
    this.knowledge.setDoctrine(store);
  }

  setFileDropStore(store: FileDropStore | undefined): void {
    this.knowledge.setFileDropStore(store);
  }

  setTsFilesDir(dir: string | undefined, virtualServerId?: number): void {
    this.knowledge.setTsFilesDir(dir, virtualServerId);
  }

  updateFileDrop(enabled: boolean, pollSec?: number): void {
    this.knowledge.updateFileDrop(enabled, pollSec);
  }

  updateRag(enabled: boolean, topK?: number): void {
    this.llm.updateRag(enabled, topK);
  }

  getRagStatus() {
    return this.knowledge.getRagStatus();
  }

  queryRag(question: string, topK?: number, allowedClassifications?: string[]) {
    return this.knowledge.queryRag(question, topK, allowedClassifications);
  }

  /** Doctrine registry rows for MCP / admin list (empty when RAG corpus not wired). */
  listDoctrineDocs() {
    return this.knowledge.getDoctrine()?.list() ?? [];
  }

  /** Recent play history for this bot instance (MCP music_history). */
  getPlayHistoryRecords(limit = 50) {
    return this.database.getPlayHistory(this.id, Math.min(200, Math.max(1, limit)));
  }

  saveWorkflowDoc(kind: WorkflowKind, markdown: string) {
    return this.knowledge.saveWorkflowDoc(kind, markdown);
  }

  saveAnalystDoc(markdown: string, classification?: string) {
    return this.knowledge.saveAnalystDoc(markdown, classification);
  }

  updateMemory(enabled: boolean): void {
    this.llm.updateMemory(enabled);
  }

  updateMemPalace(enabled: boolean, url?: string): void {
    this.config.mempalaceEnabled = enabled;
    if (url !== undefined) this.config.mempalaceUrl = url;
    this.mempalace = this.createMemPalaceClient();
    this.memory.setMemPalace(this.mempalace, enabled, url);
    this.kg.setMemPalace(this.mempalace);
    this.llm.refreshRetrieveHook();
  }

  updateKg(enabled: boolean): void {
    this.llm.updateKg(enabled);
  }

  async syncKgToMemPalace(): Promise<{ synced: number; failed: number; skipped: boolean }> {
    return this.kg.syncToMemPalace();
  }

  async syncMemoryToMemPalace(): Promise<{
    synced: number;
    failed: number;
    skipped: boolean;
    total?: number;
  }> {
    return this.memory.syncToMemPalace();
  }

  async getMemPalaceStatus(): Promise<{
    configured: boolean;
    available: boolean;
    url: string;
    memoryEnabled: boolean;
    kgEnabled: boolean;
    lastUserSync: {
      synced: number;
      failed: number;
      skipped: boolean;
      total?: number;
      at: number;
    } | null;
  }> {
    const envUrl = (process.env.MEMPALACE_URL || "").trim();
    const url = (this.config.mempalaceUrl || envUrl || "").trim();
    const last = this.memory.getLastSync();
    const base = {
      url,
      memoryEnabled: !!this.config.memoryEnabled,
      kgEnabled: !!this.config.kgEnabled,
      lastUserSync: last ? { ...last.result, at: last.at } : null,
    };
    if (!this.config.mempalaceEnabled || !url) {
      return { configured: false, available: false, ...base };
    }
    const available = this.mempalace ? await this.mempalace.isAvailable() : false;
    return { configured: true, available, ...base };
  }

  private createMemPalaceClient(): MemPalaceClient | null {
    if (!this.config.mempalaceEnabled) return null;
    const url = this.config.mempalaceUrl?.trim() || (process.env.MEMPALACE_URL || "").trim();
    if (!url) return null;
    if (!this.config.mempalaceUrl?.trim() && url) {
      this.config.mempalaceUrl = url;
    }
    return new MemPalaceClient({ url, logger: this.logger });
  }

  private createAceStepClient(): AceStepClient | null {
    if (!this.config.aceStepEnabled) return null;
    const url = this.config.aceStepUrl?.trim() || (process.env.ACE_STEP_URL || "").trim();
    if (!url) return null;
    if (!this.config.aceStepUrl?.trim() && url) {
      this.config.aceStepUrl = url;
    }
    return new AceStepClient({
      url,
      timeoutMs: this.config.aceStepTimeoutMs || 300_000,
      logger: this.logger,
    });
  }

  /** Hot-apply ACE-Step settings from the web UI (A3). */
  updateAceStep(partial: {
    enabled?: boolean;
    url?: string;
    autoFill?: boolean;
    timeoutMs?: number;
    outputDir?: string;
    maxFiles?: number;
  }): void {
    if (partial.enabled !== undefined) this.config.aceStepEnabled = partial.enabled;
    if (partial.url !== undefined) this.config.aceStepUrl = partial.url;
    if (partial.autoFill !== undefined) this.config.aceStepAutoFill = partial.autoFill;
    if (partial.timeoutMs !== undefined) this.config.aceStepTimeoutMs = partial.timeoutMs;
    if (partial.outputDir !== undefined) this.config.aceStepOutputDir = partial.outputDir;
    if (partial.maxFiles !== undefined) this.config.aceStepMaxFiles = partial.maxFiles;
    this.aceStep = this.createAceStepClient();
  }

  async getAceStepStatus(): Promise<{
    configured: boolean;
    available: boolean;
    url: string;
    autoFill: boolean;
    engine?: string;
    busy?: boolean;
    error?: string;
    mock?: boolean;
    workerConfigured?: boolean;
  }> {
    const url = (this.config.aceStepUrl || process.env.ACE_STEP_URL || "").trim();
    const configured = !!this.config.aceStepEnabled && !!url;
    if (!configured) {
      return {
        configured: false,
        available: false,
        url,
        autoFill: !!this.config.aceStepAutoFill,
      };
    }
    if (!this.aceStep) this.aceStep = this.createAceStepClient();
    if (!this.aceStep) {
      return { configured: true, available: false, url, autoFill: !!this.config.aceStepAutoFill };
    }
    const h = await this.aceStep.health();
    return {
      configured: true,
      available: h.ok,
      url,
      autoFill: !!this.config.aceStepAutoFill,
      engine: h.engine,
      busy: h.busy,
      error: h.error,
      mock: h.mock,
      workerConfigured: h.workerConfigured,
    };
  }

  /**
   * Web / API entry for ACE-Step generation (same path as !generate).
   * Invoker key is used for rate limiting.
   */
  handleAceStepGenerate(prompt: string, invokerKey = "web"): Promise<string> {
    return this.generateProvider.handleGenerate(prompt, invokerKey);
  }

  getLlmStatus() {
    return this.llm.getLlmStatus();
  }

  askLlm(question: string) {
    return this.llm.askLlm(question);
  }

  /**
   * Admin harness cockpit (H1/H2/H5): grounded ask or intent+tools with a
   * structured turn (sources, tool records, errors).
   */
  async runHarnessTurn(
    question: string,
    opts?: {
      mode?: import("../harness/index.js").HarnessMode;
      dryRun?: boolean;
      allowDangerous?: boolean;
    },
  ): Promise<import("../harness/index.js").HarnessTurn> {
    const { runHarnessTurn, InMemoryHarnessStore } = await import("../harness/index.js");
    if (!this.harnessStore) {
      this.harnessStore = new InMemoryHarnessStore(50);
    }
    const mode = opts?.mode === "intent" ? "intent" : "ask";
    const mod = this.llm.getModule();
    return runHarnessTurn(question, mode, {
      llm: mod
        ? {
            ask: (q, conv) => mod.ask(q, conv),
            chatForIntent: (q, conv) => mod.chatForIntent(q, conv),
          }
        : null,
      retrieve: async (q) => this.llm.retrieveForHarness(q),
      brainUrl: (process.env.BRAIN_URL ?? "").trim() || undefined,
      channel: "dashboard",
      executeTool: async (name, args) => {
        return this.disposeBrainTool(name, args, {
          dryRun: opts?.dryRun === true,
          allowDangerous:
            opts?.allowDangerous === true || this.config.harnessIntentAllowDangerous === true,
        });
      },
      store: this.harnessStore,
      conversationId: "harness-dashboard",
    });
  }

  /**
   * Phase D — dispose a single brain tool proposal (rights / dry-run via harness policy).
   * Used by harness and POST /v1/turn when executeTools is true.
   */
  async disposeBrainTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { dryRun?: boolean; allowDangerous?: boolean },
  ): Promise<{ ok: boolean; result?: string; error?: string }> {
    const { decideHarnessTool } = await import("../harness/tool-policy.js");
    const decision = decideHarnessTool(name, {
      dryRun: opts?.dryRun === true,
      allowDangerous:
        opts?.allowDangerous === true || this.config.harnessIntentAllowDangerous === true,
    });
    if (decision.action === "dry_run") {
      return { ok: true, result: `[dry-run] would run ${name}` };
    }
    if (decision.action === "block") {
      return { ok: false, error: decision.reason };
    }
    try {
      const { toolCallToCommand } = await import("../control/router.js");
      const cmd = toolCallToCommand({ name, arguments: args });
      if (!cmd) {
        return { ok: false, error: `unknown or invalid tool: ${name}` };
      }
      const text = await this.commands.execute(cmd);
      return { ok: true, result: text ?? "(ok)" };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Phase D — LLM surface for in-process brain (null when LLM off). */
  getLlmModuleForBrain(): {
    ask: (q: string, conv?: string) => Promise<string>;
    chatForIntent: (
      q: string,
      conv?: string,
    ) => Promise<{
      content: string | null;
      toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
    }>;
  } | null {
    const mod = this.llm.getModule();
    if (!mod) return null;
    return {
      ask: (q, conv) => mod.ask(q, conv),
      chatForIntent: (q, conv) => mod.chatForIntent(q, conv),
    };
  }

  /** Phase D — RAG chunks for brain sources. */
  async retrieveForBrain(question: string) {
    return this.llm.retrieveForHarness(question);
  }

  /** G3 — member-safe live snapshot. */
  async getLiveStatus(): Promise<{
    connected: boolean;
    nowPlaying: { name: string; artist?: string } | null;
    queue: Array<{ name: string; artist?: string }>;
    radio: {
      enabled: boolean;
      activeProfile: string;
      songsUntilBumper: number | null;
      cuePending: boolean;
      nextBumperHint: string;
    } | null;
    scope: ReturnType<typeof import("./scope.js").resolveScope>;
  }> {
    const { resolveScope, parseBotScope, defaultBotScope } = await import("./scope.js");
    const scope = resolveScope(parseBotScope(this.config.scope ?? defaultBotScope()), {
      botName: this.name,
    });
    const cur = this.queue.current();
    const q = this.queue
      .list()
      .slice(0, 20)
      .map((s) => ({ name: s.name, artist: s.artist }));
    let radio: {
      enabled: boolean;
      activeProfile: string;
      songsUntilBumper: number | null;
      cuePending: boolean;
      nextBumperHint: string;
    } | null = null;
    if (this.config.radio) {
      const st = this.radio.status();
      const hint =
        st.songsUntilBumper == null
          ? "Radio off or no every-N clock"
          : st.songsUntilBumper === 0
            ? "Bumper due next break"
            : `Next bumper in ${st.songsUntilBumper} track(s)`;
      radio = {
        enabled: !!this.config.radio.enabled,
        activeProfile: this.config.radio.activeProfile,
        songsUntilBumper: st.songsUntilBumper,
        cuePending: st.cuePending,
        nextBumperHint: hint,
      };
    }
    return {
      connected: this.connected,
      nowPlaying: cur ? { name: cur.name, artist: cur.artist } : null,
      queue: q,
      radio,
      scope,
    };
  }

  /** V3 — spoken radio/status liner via speech sink. */
  async speakRadioStatus(): Promise<string> {
    const live = await this.getLiveStatus();
    const parts = [
      live.nowPlaying
        ? `Now playing ${live.nowPlaying.name}${live.nowPlaying.artist ? ` by ${live.nowPlaying.artist}` : ""}.`
        : "Nothing is playing.",
      live.radio?.enabled
        ? `Radio is on, profile ${live.radio.activeProfile}. ${live.radio.nextBumperHint}.`
        : "Radio is off.",
    ];
    const text = parts.join(" ");
    try {
      const r = await this.radio.cueSay(text);
      if (r === "played" || r === "cued") return `📻 ${text}`;
      return `📻 ${text} (speech unavailable — text only)`;
    } catch {
      return `📻 ${text} (speech failed — text only)`;
    }
  }

  /** G4 — mute/kick via TS client; fail-open on transport errors. */
  async moderationAction(
    action: "mute" | "kick",
    target: string,
    canRun: (cmd: string) => boolean,
  ): Promise<string> {
    if (!canRun("mute") && !canRun("kick") && !canRun("moveclient")) {
      return "You don't have permission for moderation actions.";
    }
    if (action === "mute" && !canRun("mute") && !canRun("moveclient")) {
      return "You don't have permission to mute (needs mute or moveclient).";
    }
    if (action === "kick" && !canRun("kick") && !canRun("moveclient")) {
      return "You don't have permission to kick (needs kick or moveclient).";
    }
    if (!this.connected) return "Bot is not connected — moderation skipped (music unaffected).";
    try {
      // Soft implementation: poke + chat notice; full mute depends on TS library surface.
      const msg =
        action === "mute"
          ? `Moderation: mute requested for ${target} (apply via server groups if API unavailable).`
          : `Moderation: kick requested for ${target} (apply via server groups if API unavailable).`;
      const clients = await this.tsClient.getClientsInChannel();
      const t = target.trim().toLowerCase();
      const hit = clients.find((c) => {
        const nick = String(
          (c as { nickname?: string; name?: string }).nickname ??
            (c as { name?: string }).name ??
            "",
        ).toLowerCase();
        const id = String(
          (c as { id?: number | string; clid?: number | string }).id ??
            (c as { clid?: number }).clid ??
            "",
        );
        return id === t || nick.includes(t);
      }) as { id?: number; clid?: number; nickname?: string; name?: string } | undefined;
      const clid = Number(hit?.id ?? hit?.clid);
      if (!hit || !Number.isFinite(clid)) {
        return `No client matching "${target}" in channel. Music unaffected.`;
      }
      try {
        await this.tsClient.pokeClient(clid, `Moderation: ${action}`);
      } catch {
        /* fail-open */
      }
      return `${msg} Target: ${hit.nickname ?? hit.name ?? clid}.`;
    } catch (err) {
      return `Moderation ${action} failed open: ${err instanceof Error ? err.message : String(err)}. Music unaffected.`;
    }
  }

  listHarnessTurns(limit = 30) {
    return this.harnessStore?.list(limit) ?? [];
  }

  /** Seed org KG fact (R4) — SQLite + MemPalace when enabled. Never uses !remember rooms. */
  seedOrgKgFact(fact: string, invokerUid?: string): string {
    return this.kg.handleKg(`remember ${fact}`, invokerUid, () => true);
  }

  seedOrgKgFactAsync(fact: string, invokerUid?: string) {
    return this.kg.seedOrgFact(fact, invokerUid);
  }

  listOrgKgFacts(limit = 20) {
    return this.kg.listFacts(limit);
  }

  /** Org memory search for bumpers: MemPalace kgSearch, else SQLite KG. Never private rooms. */
  async searchOrgMemory(query: string, limit = 5): Promise<Array<{ fact: string }>> {
    return this.kg.searchOrg(query, limit);
  }

  handleOps(args: string, canRun?: (c: string) => boolean) {
    this.refreshScOrgPlugin();
    return this.ops.handle(args, canRun ?? (() => true));
  }

  getStatusRegistry() {
    return this.statusRegistry;
  }

  /** Rebind SC org plugin from live config / env (G2). */
  refreshScOrgPlugin(): void {
    const base =
      (this.config.scOrgStatusUrl || process.env.SC_ORG_STATUS_URL || "").trim() || undefined;
    const orgName = (this.config.scOrgName || process.env.SC_ORG_NAME || "").trim() || undefined;
    this.statusRegistry.register(
      createStarCitizenOrgStatusPlugin({ baseUrl: base ?? "", orgName }),
    );
  }

  getMemoryScopesSnapshot(privateUid?: string) {
    const privateCount = privateUid ? this.memory.countFacts(privateUid) : undefined;
    return buildScopesSnapshot({
      memoryEnabled: this.config.memoryEnabled,
      kgEnabled: this.config.kgEnabled,
      memoryBroadcastOptIn: this.config.radio?.memoryBroadcastOptIn,
      privateCount,
      orgCount: this.kg.listFacts(500).length,
    });
  }

  listPrivateMemory(uid: string, limit = 20) {
    return this.memory.listFacts(uid, limit);
  }

  runUnderMusicSmoke(partial?: Partial<UnderMusicConfig>) {
    const vc = this.config.voice ?? {};
    return runUnderMusicSmoke(
      defaultUnderMusicConfig({
        duckMusicOnSpeech: vc.duckMusicOnSpeech !== false,
        duckMusicVolume: vc.duckMusicVolume,
        listenWindowMs: vc.listenWindowMs,
        textWakeFallback: vc.textWakeFallback !== false,
        watchword: vc.watchword,
        ...partial,
      }),
    );
  }

  async runRagEval(cases?: EvalCase[]) {
    return runEvalLoop(cases ?? DEFAULT_EVAL_CASES, {
      queryDoctrine: async (q) => {
        if (!this.config.ragEnabled) return [];
        const chunks = await this.queryRag(q);
        return (chunks ?? []).map((c) => ({
          text: c.text,
          source: c.source,
          score: c.score,
          classification: c.classification,
        }));
      },
      queryOrgMemory: async (q) => this.kg.searchOrg(q, 8),
    });
  }

  updateRights(enabled: boolean, rights?: RightsConfig): void {
    this.rights.updateRights(enabled, rights);
  }

  getEffectiveRights(opts?: { uid?: string; serverGroups?: string[] }) {
    return this.rights.getEffectiveRights(opts);
  }

  updateStreamBridge(url: string): void {
    this.config.streamBridgeUrl = url;
    if (this.streamProvider instanceof StreamProvider) {
      this.streamProvider.setBridgeUrl(url);
    }
  }

  updateVoice(voice: Partial<VoiceConfig>): void {
    this.config.voice = { ...defaultVoiceConfig(), ...this.config.voice, ...voice };
    this.voice.disable();
    if (this.config.voice.enabled) {
      this.voice.enable();
    }
  }

  getVoiceStatus() {
    return this.voice.getStatus();
  }

  testVoiceTurn(transcript: string, opts?: { speak?: boolean }) {
    return this.voice.runSyntheticTurn(transcript, opts);
  }

  /** Prerecorded bumper asset directory (§6.5 pin-to-pool). */
  resolveBumperDir(dataDir = dirname(this.database.db.name)): string {
    const custom = this.config.radio.bumperDir;
    if (custom) return isAbsolute(custom) ? custom : join(dataDir, custom);
    return join(dataDir, "bumpers");
  }

  cueRadioBumper(topic?: string) {
    return this.radio.cueBumper(topic);
  }

  /**
   * Pre-render station/time (and optional doctrine) bumpers into TTS cache
   * so the next live bumper doesn't wait on synthesis.
   */
  prewarmRadioBumpers(opts?: { includeDoctrine?: boolean; hoursAhead?: number; lines?: string[] }) {
    return this.bumperFactory.prewarm(opts ?? {});
  }

  /** Drop all TTS bumper cache entries (after voice/model change). */
  clearRadioBumperCache(): { removed: number } {
    return this.bumperCache.clearAll();
  }

  /** Chat/voice presence hint for radio minPresent gate. */
  noteRadioHumanActivity(clid: number): void {
    this.radio.noteHumanActivity(clid);
  }

  getRadioStatus() {
    return {
      enabled: this.config.radio.enabled,
      activeProfile: this.config.radio.activeProfile,
      profiles: Object.keys(this.config.radio.profiles),
      ...this.radio.status(),
      lastBumper: this.radio.getLastPlayedBumper(),
      icecast: this.icecastTee.status(),
      relay: this.relayScheduler.status(),
    };
  }

  /** Hot-apply radio.icecast tee settings (Settings save). */
  applyIcecastTee(
    partial?: { enabled?: boolean; mountUrl?: string; format?: "mp3" | "ogg" | "opus" } | null,
  ) {
    return this.icecastTee.apply(partial ?? this.config.radio?.icecast ?? null);
  }

  /**
   * Hot-apply radio music color overlay (AM/FM/… ffmpeg -af).
   * Takes effect on the next music track (speech/bumpers stay clean).
   */
  applyAudioColor(preset?: string | null): void {
    const p = parseAudioColorPreset(preset ?? this.config.radio?.audioColor ?? "off");
    if (this.config.radio) this.config.radio.audioColor = p;
    // Color is a DJ/station vibe — only when radio mode is enabled.
    const active = !!this.config.radio?.enabled && p !== "off";
    this.player.setMusicAudioFilter(active ? audioColorFilter(p) : null);
    this.logger.info({ audioColor: p, active }, "radio music audio color applied");
  }

  /** Tee PCM to Icecast when running (fail-open). */
  teeIcecastPcm(pcm: Buffer): void {
    this.icecastTee.writePcm(pcm);
  }

  updateRoast(
    enabled: boolean,
    minPresent?: number,
    cooldownMinutes?: number,
    minScore?: number,
  ): void {
    this.config.roastEnabled = enabled;
    if (minPresent !== undefined) this.config.roastMinPresent = minPresent;
    if (cooldownMinutes !== undefined) this.config.roastCooldownMinutes = cooldownMinutes;
    if (minScore !== undefined) this.config.roastMinScore = minScore;
  }

  canWebUserRunCommand(
    user: { id: string; username: string; role: "admin" | "member" },
    commandName: string,
  ): Promise<boolean> {
    return this.routed.canWebUserRunCommand(user, commandName);
  }

  executeRoutedCommand(
    cmd: ParsedCommand,
    opts?: {
      webUser?: { id: string; username: string; role: "admin" | "member" };
      message?: TS3TextMessage;
    },
  ) {
    return this.routed.executeRoutedCommand(cmd, opts);
  }

  executeCommand(cmd: ParsedCommand, msg?: TS3TextMessage): Promise<string | null> {
    return this.commands.execute(cmd, msg);
  }

  getProviderFor(platform: "local" | "youtube" | "stream"): MusicProvider {
    return this.playback.getProviderFor(platform);
  }

  resolveLocalMusic(input: string) {
    return this.localProvider.resolve?.(input) ?? Promise.resolve(null);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getCurrentQueue(): QueuedSong[] {
    return this.queue.list ? this.queue.list() : [];
  }

  async playResolvedItem(
    resolved: { type: "song" | "playlist"; item: unknown },
    platform: "local" | "youtube" | "stream" = "local",
  ): Promise<string> {
    return this.playback.playResolvedItem(resolved, platform);
  }

  async addResolvedItem(
    resolved: { type: "song" | "playlist"; item: unknown },
    platform: "local" | "youtube" | "stream" = "local",
  ): Promise<string> {
    return this.playback.addResolvedItem(resolved, platform);
  }

  clearQueueAndStop(): void {
    this.playback.clearQueueAndStop();
  }

  async skipNext(): Promise<void> {
    return this.playback.skipNext();
  }

  pausePlayback(): void {
    this.playback.pausePlayback();
  }

  resumePlayback(): void {
    this.playback.resumePlayback();
  }

  setVolume(volume: number): void {
    this.playback.setVolume(volume);
  }

  async resolveAndPlay(song: QueuedSong): Promise<boolean> {
    return this.playback.resolveAndPlay(song);
  }

  /**
   * Recount humans in bot channel (listClients via getClientsInChannel) and
   * push into the radio director. Used by honeybbq enter/leave/moved + poll backup.
   */
  private async syncRadioChannelPresence(): Promise<void> {
    // Membership events can burst (mass joins/moves) and each sync awaits a
    // serverquery round-trip; without an epoch check a slow older reply could
    // land after a newer one and overwrite the fresher count.
    const epoch = ++this.presenceSyncEpoch;
    try {
      const clients = await this.tsClient.getClientsInChannel();
      if (epoch !== this.presenceSyncEpoch) return; // stale reply — a newer sync superseded it
      const humans = countChannelHumans(clients, this.tsClient.getClientId());
      this.voice.refreshClientCache(clients);
      this.radio.onPoll(clients, humans);
    } catch (err) {
      this.logger.debug?.({ err }, "radio: channel presence sync failed");
    }
  }

  async playNext(maxRetries = 3): Promise<boolean> {
    return this.playback.playNext(maxRetries);
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

  /** True while the !test / PHASE0 demo track is the current song. */
  isDemoTestPlaying(): boolean {
    return this.playback.isDemoTestPlaying();
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
