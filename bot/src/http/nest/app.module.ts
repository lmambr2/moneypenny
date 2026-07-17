import type http from "node:http";
import { type DynamicModule, Module } from "@nestjs/common";
import type { Express } from "express";
import type { WebServerOptions } from "../types.js";
import { SystemController } from "./controllers/system.controller.js";
import {
  BrainHttpModule,
  McpHttpModule,
  SessionHttpModule,
  SpaHttpModule,
  StationApiHttpModule,
  SystemHttpModule,
  WebsocketHttpModule,
} from "./domain.modules.js";
import { NEST_DOMAIN_BUNDLES } from "./domain-bundles.js";
import { HttpBootstrapService } from "./http-bootstrap.service.js";
import { DOMAIN_PLUGIN_BUNDLE, WEB_OPTIONS } from "./tokens.js";

export interface NestHttpModuleOptions {
  options: WebServerOptions;
  expressApp: Express;
  httpServer: http.Server;
}

/**
 * Root Nest module (PR-C3+): system Nest controllers + domain plugin bundles.
 * Domain APIs (player/bot/music/…) remain Express routers under web/api/*;
 * public system routes are Nest controllers.
 */
@Module({})
export class NestHttpAppModule {
  static register(opts: NestHttpModuleOptions): DynamicModule {
    return {
      module: NestHttpAppModule,
      imports: [
        SystemHttpModule,
        McpHttpModule,
        SessionHttpModule,
        BrainHttpModule,
        StationApiHttpModule,
        SpaHttpModule,
        WebsocketHttpModule,
      ],
      controllers: [SystemController],
      providers: [
        { provide: WEB_OPTIONS, useValue: opts.options },
        { provide: "EXPRESS_APP", useValue: opts.expressApp },
        { provide: "HTTP_SERVER", useValue: opts.httpServer },
        { provide: DOMAIN_PLUGIN_BUNDLE, useValue: NEST_DOMAIN_BUNDLES },
        HttpBootstrapService,
      ],
      exports: [HttpBootstrapService],
    };
  }
}
