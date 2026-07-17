import "reflect-metadata";
import http from "node:http";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import express from "express";
import type { WebServer, WebServerOptions } from "../types.js";
import { NestHttpAppModule } from "./app.module.js";
import { HttpBootstrapService } from "./http-bootstrap.service.js";

/**
 * NestJS + Express adapter HTTP server (PR-C3).
 * Same routes/plugins as the plugin-only path; Nest modules map domains.
 */
export async function createNestWebServer(options: WebServerOptions): Promise<WebServer> {
  const expressApp = express();
  const server = http.createServer(expressApp);
  const adapter = new ExpressAdapter(expressApp);

  const nestApp = await NestFactory.create(
    NestHttpAppModule.register({
      options,
      expressApp,
      httpServer: server,
    }),
    adapter,
    {
      // Use station pino logger; suppress Nest's default console logger noise.
      logger: false,
      abortOnError: false,
    },
  );

  await nestApp.init();
  const bootstrap = nestApp.get(HttpBootstrapService);
  const web = bootstrap.asWebServer();

  const prevStop = web.stop.bind(web);
  return {
    start: () => web.start(),
    stop: () => {
      prevStop();
      void nestApp.close();
    },
  };
}
