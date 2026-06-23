import { EventEmitter } from "node:events";
import {
  TS3Client,
  type TS3ClientOptions,
  type TS3TextMessage,
} from "../ts-protocol/client.js";
import { AudioPlayer } from "../audio/player.js";
import { PlayQueue, PlayMode, type QueuedSong } from "../audio/queue.js";
import type { MusicProvider } from "../music/provider.js";
import { StreamProvider } from "../music/stream.js";
import type { ParsedCommand } from "./commands.js";
import type { Logger } from "../logger.js";
import type { BotDatabase } from "../data/database.js";
import type { BotConfig } from "../data/config.js";
import { BotProfileManager } from "./profile.js";
import type { AvatarStore } from "../data/avatars.js";
import { RoastStore } from "../data/roast.js";
import { ControlRouter } from "../control/router.js";
import { registerBotCommandHandlers } from "../control/register-handlers.js";
import type { RetrievalStore } from "../rag/index.js";
import { MemoryStore } from "../data/memory.js";
import { KgStore } from "../data/kg.js";
import { MemPalaceClient } from "../memory/mempalace-client.js";
import type { DoctrineStore } from "../data/doctrine.js";
import type { FileDropStore } from "../data/file-drop.js";
import type { RightsConfig, Subject } from "../rights/index.js";
import { PlaybackEngine } from "./playback/engine.js";
import { CommandExecutor } from "./commands/executor.js";
import { RoastService } from "./community/roast.js";
import { MemoryService } from "./community/memory.js";
import { KgService } from "./community/kg.js";
import { VoiceSession } from "./voice/session.js";
import { defaultVoiceConfig, type VoiceConfig } from "../voice/types.js";
import { LlmRuntime } from "./llm/runtime.js";
import type { WorkflowKind } from "../docs/workflow.js";
import { KnowledgeService } from "./knowledge/service.js";
import { IdlePoller } from "./lifecycle/idle-poller.js";
import { schedulePhase0AutoPlay } from "./lifecycle/phase0.js";
import { bindPlayerEvents, bindTsEvents } from "./lifecycle/event-bindings.js";
import { TextMessageHandler } from "./control/text-handler.js";
import { RightsRuntime } from "./rights/runtime.js";
import { RoutedCommandExecutor } from "./control/routed-executor.js";
import { createYtLibrary } from "./factory/yt-library.js";

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
  private knowledge: KnowledgeService;
  private llm: LlmRuntime;
  private idlePoller: IdlePoller;
  private text: TextMessageHandler;
  private rights: RightsRuntime;
  private routed: RoutedCommandExecutor;
  private mempalace: MemPalaceClient | null = null;
  private voice: VoiceSession;
  private connected = false;
  private disconnectEmitted = false;
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
    const ytLibrary = createYtLibrary({
      db: this.database.db,
      localProvider: this.localProvider,
      youtubeProvider: this.youtubeProvider,
      logger: this.logger,
    });

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

    this.knowledge = new KnowledgeService({
      config: this.config,
      logger: this.logger,
      tsClient: this.tsClient,
      localProvider: this.localProvider,
      isConnected: () => this.connected,
    });

    this.controlRouter = new ControlRouter(this.logger, undefined);

    this.rights = new RightsRuntime({
      config: this.config,
      logger: this.logger,
      tsClient: this.tsClient,
    });
    this.rights.initialize();

    this.mempalace = this.createMemPalaceClient();

    this.kg = new KgService({
      store: kgStore,
      config: this.config,
      mempalace: this.mempalace,
      logger: this.logger,
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
      setAdvancing: (v) => { this.isAdvancing = v; },
    });

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

    this.idlePoller = new IdlePoller({
      config: this.config,
      logger: this.logger,
      tsClient: this.tsClient,
      isConnected: () => this.connected,
      onDisconnect: () => this.disconnect(),
      onPoll: (clients, userCount) => {
        this.voice.refreshClientCache(clients);
        if (this.config.roastEnabled) {
          this.roast.runTick(userCount).catch(() => {});
        }
      },
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
      knowledge: this.knowledge,
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
      logger: this.logger,
      playNext: () => this.playNext(),
    });

    bindTsEvents({
      tsClient: this.tsClient,
      text: this.text,
      idlePoller: this.idlePoller,
      knowledge: this.knowledge,
      player: this.player,
      voice: this.voice,
      logger: this.logger,
      setConnected: (v) => { this.connected = v; },
      isDisconnectEmitted: () => this.disconnectEmitted,
      setDisconnectEmitted: (v) => { this.disconnectEmitted = v; },
      emitDisconnected: () => this.emit("disconnected"),
    });
  }

  async connect(): Promise<void> {
    this.disconnectEmitted = false;
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

  disconnect(): void {
    this.idlePoller.stop();
    this.knowledge.stopFileDropWatcher();
    this.player.stop();
    this.voice.cleanup();
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
      enabled, url, model, systemPrompt, temperature,
      fallbackUrl, fallbackModel, delegateUrl, delegateModel,
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

  queryRag(
    question: string,
    topK?: number,
    allowedClassifications?: string[],
  ) {
    return this.knowledge.queryRag(question, topK, allowedClassifications);
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

  async syncMemoryToMemPalace(): Promise<{ synced: number; failed: number; skipped: boolean }> {
    return this.memory.syncToMemPalace();
  }

  async getMemPalaceStatus(): Promise<{ configured: boolean; available: boolean; url: string }> {
    const url = this.config.mempalaceUrl ?? "";
    if (!this.config.mempalaceEnabled || !url.trim()) {
      return { configured: false, available: false, url };
    }
    const available = this.mempalace ? await this.mempalace.isAvailable() : false;
    return { configured: true, available, url };
  }

  private createMemPalaceClient(): MemPalaceClient | null {
    if (!this.config.mempalaceEnabled) return null;
    const url = this.config.mempalaceUrl?.trim();
    if (!url) return null;
    return new MemPalaceClient({ url, logger: this.logger });
  }

  getLlmStatus() {
    return this.llm.getLlmStatus();
  }

  askLlm(question: string) {
    return this.llm.askLlm(question);
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

  updateRoast(enabled: boolean, minPresent?: number, cooldownMinutes?: number): void {
    this.config.roastEnabled = enabled;
    if (minPresent !== undefined) this.config.roastMinPresent = minPresent;
    if (cooldownMinutes !== undefined) this.config.roastCooldownMinutes = cooldownMinutes;
  }

  canWebUserRunCommand(
    user: { id: string; username: string; role: "admin" | "member" },
    commandName: string,
  ): Promise<boolean> {
    return this.routed.canWebUserRunCommand(user, commandName);
  }

  executeRoutedCommand(
    cmd: ParsedCommand,
    opts?: { webUser?: { id: string; username: string; role: "admin" | "member" }; message?: TS3TextMessage },
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