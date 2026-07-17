import http from "node:http";
import cookieParser from "cookie-parser";
import express from "express";
import { createAuditStore } from "../data/audit.js";
import { createSessionStore } from "../data/sessions.js";
import { createUserStore } from "../data/users.js";
import { registerMcp } from "./plugins/mcp.js";
import { registerOpenApi } from "./plugins/openapi.js";
import { registerProtectedApi } from "./plugins/protected-api.js";
import { registerPublicRoutes } from "./plugins/public-routes.js";
import { registerSecurity } from "./plugins/security.js";
import { registerSession } from "./plugins/session.js";
import { registerStaticSpa } from "./plugins/static-spa.js";
import { registerWebSocket } from "./plugins/websocket.js";
import type { HttpAppContext, HttpPlugin, WebServer, WebServerOptions } from "./types.js";

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Plugin order matters (auth gates, body parsers, SPA fallback).
 * Domain routers stay in `web/api/*`; this file only composes HTTP plugins.
 */
const PLUGINS: HttpPlugin[] = [
  registerSecurity,
  registerPublicRoutes,
  registerOpenApi,
  registerMcp,
  registerSession,
  registerProtectedApi,
  registerStaticSpa,
  registerWebSocket,
];

/**
 * Build the station HTTP + WebSocket server (PR-C1).
 * Express today; plugins keep a path open for Fastify-style modules later (Phase C3).
 */
export function createWebServer(options: WebServerOptions): WebServer {
  const app = express();
  const server = http.createServer(app);
  const logger = options.logger.child({ component: "web" });

  // S2: JSON body limits are scoped behind auth in registerProtectedApi.
  // Pre-auth surface (login/setup) keeps the body-parser default (100kb).
  app.use(cookieParser());

  const users = createUserStore(options.database.db);
  const sessions = createSessionStore(options.database.db);
  const audit = createAuditStore(options.database.db);
  const onStop: Array<() => void> = [];

  const ctx: HttpAppContext = {
    options,
    app,
    server,
    logger,
    users,
    sessions,
    audit,
    onStop,
  };

  for (const plugin of PLUGINS) {
    plugin(ctx);
  }

  server.on("error", (err) => {
    logger.error({ err }, "HTTP server error");
  });

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
      for (const fn of onStop) {
        try {
          fn();
        } catch (err) {
          logger.error({ err }, "HTTP onStop hook failed");
        }
      }
      server.close();
    },
  };
}
