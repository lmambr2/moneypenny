import type http from "node:http";
import type { Express } from "express";
import type { BotManager } from "../bot/manager.js";
import type { AuditStore } from "../data/audit.js";
import type { AvatarStore } from "../data/avatars.js";
import type { BotConfig } from "../data/config.js";
import type { BotDatabase } from "../data/database.js";
import type { DoctrineStore } from "../data/doctrine.js";
import type { SessionStore } from "../data/sessions.js";
import type { UserStore } from "../data/users.js";
import type { Logger } from "../logger.js";
import type { PlaybackBlacklist } from "../music/playback-blacklist.js";
import type { MusicProvider } from "../music/provider.js";
import type { RadioAnalyzer, TagStore } from "../radio/index.js";
import type { RetrievalStore } from "../rag/index.js";

export interface WebServerOptions {
  port: number;
  /** Interface to bind. Default 127.0.0.1 (localhost-only). DESIGN §11. */
  host?: string;
  botManager: BotManager;
  localProvider: MusicProvider;
  youtubeProvider: MusicProvider;
  streamProvider: MusicProvider;
  database: BotDatabase;
  config: BotConfig;
  configPath: string;
  logger: Logger;
  avatarStore: AvatarStore;
  staticDir?: string;
  /** RAG substrate (ROADMAP Phase 5). Present only when ragEnabled. */
  retrieval?: RetrievalStore;
  /** Doctrine corpus store (ROADMAP Phase 6). Present only when ragEnabled. */
  doctrine?: DoctrineStore;
  /** Radio tag overlay (docs/radio.md §9). Enables the tag/rating endpoints. */
  tagStore?: TagStore;
  /** Admin playback ban list. Enables blacklist API endpoints. */
  playbackBlacklist?: PlaybackBlacklist;
  /** Radio analyzer sidecar (docs/radio.md §9.5). Enables analyze API + on-ingest. */
  radioAnalyzer?: RadioAnalyzer;
}

export interface WebServer {
  start(): Promise<void>;
  stop(): void;
}

/**
 * Shared wiring context for HTTP plugins (PR-C1).
 * Stores are created once in createWebServer; plugins only mount routes/middleware.
 */
export interface HttpAppContext {
  options: WebServerOptions;
  app: Express;
  server: http.Server;
  logger: Logger;
  users: UserStore;
  sessions: SessionStore;
  audit: AuditStore;
  /** Run on WebServer.stop() (timers, WS teardown, …). */
  onStop: Array<() => void>;
}

/** Express plugin: register middleware/routes on the shared app. */
export type HttpPlugin = (ctx: HttpAppContext) => void;
