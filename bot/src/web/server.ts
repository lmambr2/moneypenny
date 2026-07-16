import http from "node:http";
import path from "node:path";
import cookieParser from "cookie-parser";
import express from "express";
import { WebSocketServer } from "ws";
import type { BotManager } from "../bot/manager.js";
import { createAuditStore } from "../data/audit.js";
import type { AvatarStore } from "../data/avatars.js";
import type { BotConfig } from "../data/config.js";
import type { BotDatabase } from "../data/database.js";
import type { DoctrineStore } from "../data/doctrine.js";
import { createSessionStore } from "../data/sessions.js";
import { createUserStore } from "../data/users.js";
import type { Logger } from "../logger.js";
import type { PlaybackBlacklist } from "../music/playback-blacklist.js";
import type { MusicProvider } from "../music/provider.js";
import type { RadioAnalyzer, TagStore } from "../radio/index.js";
import type { RetrievalStore } from "../rag/index.js";
import { loadMcpConfig } from "../mcp/index.js";
import { createMcpRouter } from "../mcp/server.js";
import { createAuditRouter } from "./api/audit.js";
import { createAuthRouter } from "./api/auth.js";
import { createBotRouter } from "./api/bot.js";
import { createEconomyRouter } from "./api/economy.js";
import { createMusicRouter } from "./api/music.js";
import { createPlayerRouter } from "./api/player.js";
import { createRagRouter } from "./api/rag.js";
import { createSessionRouter } from "./api/session.js";
import { createUsersRouter } from "./api/users.js";
import { validateSessionFromHeaders } from "./auth/validateSession.js";
import { clientIpKeyFn } from "./middleware/client-ip.js";
import { csrfOriginCheck } from "./middleware/csrf.js";
import { createRateLimit } from "./middleware/rateLimit.js";
import { requireAdmin } from "./middleware/requireAdmin.js";
import { createRequireAuth } from "./middleware/requireAuth.js";
import { setupWebSocket } from "./websocket.js";

// Music-provider cookie auth was removed; /api/auth is YouTube status only.

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

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

export function createWebServer(options: WebServerOptions): WebServer {
  const app = express();
  const server = http.createServer(app);
  const logger = options.logger.child({ component: "web" });

  if (options.config.trustProxy) {
    // Hop count for Express trust proxy (matches rate-limit XFF policy).
    const hops = Math.max(1, Math.min(5, options.config.trustProxyHops ?? 1));
    app.set("trust proxy", hops);
  }

  // Security headers: prevent the WebUI from being embedded in a third-party
  // iframe (clickjacking defence). CSP frame-ancestors is the modern equivalent
  // of X-Frame-Options; both are set for compatibility across browsers.
  app.use((_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    next();
  });

  // S2: JSON body limits are scoped, and the big parsers sit BEHIND the auth
  // gates (below) so unauthenticated requests never buffer large bodies. The
  // pre-auth surface (login/setup) gets the body-parser default (100kb).
  app.use(cookieParser());

  const users = createUserStore(options.database.db);
  const sessions = createSessionStore(options.database.db);
  const audit = createAuditStore(options.database.db);

  // ─── Public routes (no auth, no CSRF) ───────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", version: "0.1.0" });
  });

  app.get("/api/config/public-url", (_req, res) => {
    const raw = (options.config.publicUrl ?? "").trim();
    res.json({ publicUrl: raw ? raw.replace(/\/+$/, "") : null });
  });

  // ─── MCP (Grok Build / agent clients) — Bearer token, not session cookie ─
  // Mounted outside /api so requireAuth + CSRF do not apply. See docs/mcp-server.md.
  const mcpConfig = loadMcpConfig();
  if (mcpConfig.enabled) {
    app.use(mcpConfig.path, express.json({ limit: "2mb" }), createMcpRouter({
      mcpConfig,
      botManager: options.botManager,
      config: options.config,
      logger,
    }));
    logger.info(
      { path: mcpConfig.path, profile: mcpConfig.defaultProfile },
      "MCP server enabled (Bearer token auth)",
    );
  }

  // Anti-DoS: throttle expensive (bcrypt) auth endpoints.
  // 5 req per minute per IP for /login (capacity 5, refill 5/60 = ~0.083/sec).
  // 3 req per minute per IP for /setup (more limited; first-run is rare).
  const ipKey = clientIpKeyFn({
    trustProxy: !!options.config.trustProxy,
    trustProxyHops: options.config.trustProxyHops ?? 1,
  });
  const loginLimit = createRateLimit({ capacity: 5, refillPerSec: 5 / 60, keyFn: ipKey });
  const setupLimit = createRateLimit({ capacity: 3, refillPerSec: 3 / 60, keyFn: ipKey });
  app.use("/api/session/login", loginLimit);
  app.use("/api/session/setup", setupLimit);

  // CSRF before session mutators (login/setup/logout/change-password). First-run
  // setup still works from the same origin as the SPA (audit F10).
  app.use("/api", csrfOriginCheck);
  app.use("/api/session", express.json(), createSessionRouter(users, sessions, audit, logger));

  // ─── Gates for everything else under /api ───────────────────────────────
  const requireAuth = createRequireAuth(sessions);
  app.use("/api", requireAuth);

  // Authed-only body parsing. Only the (admin-gated) doctrine editor
  // legitimately sends huge JSON (up to MAX_DOCTRINE_FILE_BYTES = 15 MiB);
  // everything else caps at 2mb — the biggest remaining body is the avatar
  // dataUrl (1MB image ≈ 1.4MB base64). The /api/rag and /api/bot/recordings
  // parsers are mounted first, so the global 2mb parser skips bodies they
  // already parsed. Recordings carry base64 audio (writeRecording caps the
  // decoded payload at 50 MiB → ~68 MB base64 + JSON envelope); the route
  // itself is requireAdmin-gated.
  app.use("/api/rag", express.json({ limit: "16mb" }));
  app.use("/api/bot/recordings", express.json({ limit: "70mb" }));
  app.use("/api", express.json({ limit: "2mb" }));

  // ─── Protected routes ───────────────────────────────────────────────────
  app.use(
    "/api/bot",
    createBotRouter(
      options.botManager,
      options.config,
      options.configPath,
      logger,
      options.database,
      options.avatarStore,
      audit,
    ),
  );
  app.use(
    "/api/music",
    createMusicRouter(
      options.localProvider,
      options.youtubeProvider,
      options.streamProvider,
      logger,
      {
        tagStore: options.tagStore,
        playbackBlacklist: options.playbackBlacklist,
        radioAnalyzer: options.radioAnalyzer,
        getRadioConfig: () => options.config.radio,
        // @dj web parity: radio.tags token (admin always passes inside the middleware).
        canEditTags: async (user) => {
          const bot = options.botManager.getAllBots()[0];
          if (!bot) return false;
          return bot.canWebUserRunCommand(user, "radio.tags");
        },
        // Library "Guess (LLM)" genre/mood from title+artist (docs/radio.md §9.5).
        askLlm: async (question) => {
          const bot = options.botManager.getAllBots()[0];
          if (!bot) return null;
          return bot.askLlm(question);
        },
      },
    ),
  );
  app.use("/api/player", createPlayerRouter(options.botManager, logger, options.database));
  app.use("/api/auth", createAuthRouter(options.youtubeProvider, logger));
  // Economy dashboard (mine/refine/craft/trade/workorders/cache) — any signed-in user
  app.use("/api/economy", createEconomyRouter({ logger, audit }));
  // admin-only routes
  app.use("/api/users", requireAdmin, createUsersRouter(users, sessions, audit, logger));
  app.use("/api/audit", requireAdmin, createAuditRouter(audit));
  if (options.retrieval && options.doctrine) {
    app.use("/api/rag", requireAdmin, createRagRouter(options.retrieval, options.doctrine, logger));
  }

  // ─── Static SPA (public) ────────────────────────────────────────────────
  if (options.staticDir) {
    app.use(express.static(options.staticDir));
    app.get(/^(?!\/api|\/ws)/, (_req, res) => {
      res.sendFile(path.join(options.staticDir!, "index.html"));
    });
  }

  server.on("error", (err) => {
    logger.error({ err }, "HTTP server error");
  });

  // ─── WebSocket with manual upgrade auth ────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });
  wss.on("error", (err) => {
    logger.error({ err }, "WebSocket server error");
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }
    const reqHost = req.headers.host;
    const originHeader = req.headers.origin;
    if (originHeader) {
      let originHost: string | null = null;
      try {
        originHost = new URL(originHeader).host;
      } catch {
        // fall through; treat as missing/invalid origin
      }
      if (!originHost || originHost !== reqHost) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    const result = validateSessionFromHeaders(req.headers.cookie as string | undefined, sessions);
    if (!result) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as unknown as { userId: string }).userId = result.userId;
      wss.emit("connection", ws, req);
    });
  });
  const cleanupWs = setupWebSocket(wss, options.botManager, logger);

  // ─── Session cleanup interval ──────────────────────────────────────────
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  return {
    async start(): Promise<void> {
      const host = options.host || "127.0.0.1";
      return new Promise((resolve) => {
        server.listen(options.port, host, () => {
          logger.info({ host, port: options.port }, "Web server started");
          if (host === "0.0.0.0") {
            logger.warn(
              "Web server bound to 0.0.0.0 (all interfaces). Ensure the port is firewalled to LAN/localhost or fronted by a TLS proxy (DESIGN §11).",
            );
          }
          cleanupTimer = setInterval(() => {
            try {
              sessions.cleanupExpired();
            } catch (err) {
              logger.error({ err }, "session cleanup failed");
            }
          }, SESSION_CLEANUP_INTERVAL_MS);
          resolve();
        });
      });
    },
    stop(): void {
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      cleanupWs();
      wss.close();
      server.close();
    },
  };
}
