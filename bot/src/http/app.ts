import http from "node:http";
import cookieParser from "cookie-parser";
import express from "express";
import { createAuditStore } from "../data/audit.js";
import { createSessionStore } from "../data/sessions.js";
import { createUserStore } from "../data/users.js";
import { ALL_DOMAIN_BUNDLES } from "./nest/domain-bundles.js";
import type { HttpAppContext, HttpPlugin, WebServer, WebServerOptions } from "./types.js";

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Flatten domain bundles into ordered plugin list (shared by Express + Nest paths).
 */
export function orderedHttpPlugins(): HttpPlugin[] {
  return [...ALL_DOMAIN_BUNDLES]
    .sort((a, b) => a.order - b.order)
    .flatMap((b) => b.plugins);
}

/**
 * Classic plugin composition without Nest (fallback / tests).
 * Prefer {@link createWebServer} which uses Nest domain modules (PR-C3).
 */
export function createPluginWebServer(options: WebServerOptions): WebServer {
  const app = express();
  const server = http.createServer(app);
  const logger = options.logger.child({ component: "web" });
  const plugins = orderedHttpPlugins();

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

  for (const plugin of plugins) {
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
          logger.info(
            { host, port: options.port, framework: "express-plugins" },
            "Web server started",
          );
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

/**
 * Build the station HTTP + WebSocket server.
 *
 * - Default (PR-C3): NestJS domain modules + Express adapter
 * - `HTTP_FRAMEWORK=plugins`: pure Express plugin path (no Nest)
 */
export async function createWebServer(options: WebServerOptions): Promise<WebServer> {
  const framework = (process.env.HTTP_FRAMEWORK ?? "nest").toLowerCase();
  if (framework === "plugins" || framework === "express") {
    return createPluginWebServer(options);
  }
  const { createNestWebServer } = await import("./nest/create-nest-server.js");
  return createNestWebServer(options);
}
