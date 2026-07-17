import http from "node:http";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import cookieParser from "cookie-parser";
import type { Express } from "express";
import { createAuditStore } from "../../data/audit.js";
import { createSessionStore } from "../../data/sessions.js";
import { createUserStore } from "../../data/users.js";
import type { HttpAppContext, WebServer, WebServerOptions } from "../types.js";
import { DOMAIN_PLUGIN_BUNDLE, type DomainPluginBundle, WEB_OPTIONS } from "./tokens.js";

const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Nest bootstrap: materialize HttpAppContext and run domain plugin bundles in order.
 */
@Injectable()
export class HttpBootstrapService implements OnModuleInit {
  private ctx!: HttpAppContext;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(
    @Inject(WEB_OPTIONS) private readonly options: WebServerOptions,
    @Inject(DOMAIN_PLUGIN_BUNDLE) private readonly bundles: DomainPluginBundle[],
    @Inject("EXPRESS_APP") private readonly app: Express,
    @Inject("HTTP_SERVER") private readonly server: http.Server,
  ) {}

  onModuleInit(): void {
    const logger = this.options.logger.child({ component: "web" });
    this.app.use(cookieParser());

    const users = createUserStore(this.options.database.db);
    const sessions = createSessionStore(this.options.database.db);
    const audit = createAuditStore(this.options.database.db);
    const onStop: Array<() => void> = [];

    this.ctx = {
      options: this.options,
      app: this.app,
      server: this.server,
      logger,
      users,
      sessions,
      audit,
      onStop,
    };

    const ordered = [...this.bundles].sort((a, b) => a.order - b.order);
    for (const bundle of ordered) {
      logger.debug?.({ domain: bundle.name }, "HTTP domain module register");
      for (const plugin of bundle.plugins) {
        plugin(this.ctx);
      }
    }

    this.server.on("error", (err) => {
      logger.error({ err }, "HTTP server error");
    });
  }

  asWebServer(): WebServer {
    const options = this.options;
    const sessions = this.ctx.sessions;
    const logger = this.ctx.logger;
    const onStop = this.ctx.onStop;
    const server = this.server;

    return {
      start: async (): Promise<void> => {
        if (this.started) return;
        const host = options.host || "127.0.0.1";
        return new Promise((resolve) => {
          server.listen(options.port, host, () => {
            this.started = true;
            logger.info(
              { host, port: options.port, framework: "nestjs" },
              "Web server started",
            );
            if (host === "0.0.0.0") {
              logger.warn(
                "Web server bound to 0.0.0.0 (all interfaces). Ensure the port is firewalled to LAN/localhost or fronted by a TLS proxy (DESIGN §11).",
              );
            }
            this.cleanupTimer = setInterval(() => {
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
      stop: (): void => {
        if (this.cleanupTimer) {
          clearInterval(this.cleanupTimer);
          this.cleanupTimer = null;
        }
        for (const fn of onStop) {
          try {
            fn();
          } catch (err) {
            logger.error({ err }, "HTTP onStop hook failed");
          }
        }
        server.close();
        this.started = false;
      },
    };
  }
}
