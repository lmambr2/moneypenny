import http from "node:http";
import { DynamicModule, Module } from "@nestjs/common";
import type { Express } from "express";
import type { WebServerOptions } from "../types.js";
import { ALL_DOMAIN_BUNDLES } from "./domain-bundles.js";
import {
  BrainHttpModule,
  McpHttpModule,
  SessionHttpModule,
  SpaHttpModule,
  StationApiHttpModule,
  SystemHttpModule,
  WebsocketHttpModule,
} from "./domain.modules.js";
import { HttpBootstrapService } from "./http-bootstrap.service.js";
import { DOMAIN_PLUGIN_BUNDLE, WEB_OPTIONS } from "./tokens.js";

export interface NestHttpModuleOptions {
  options: WebServerOptions;
  expressApp: Express;
  httpServer: http.Server;
}

/**
 * Root Nest module (PR-C3): domain HTTP modules 1:1 with product surfaces.
 * Route handlers remain Express routers under web/api/*; Nest owns DI composition.
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
      providers: [
        { provide: WEB_OPTIONS, useValue: opts.options },
        { provide: "EXPRESS_APP", useValue: opts.expressApp },
        { provide: "HTTP_SERVER", useValue: opts.httpServer },
        // Domain plugin bundles (system → … → websocket) — single array provider.
        { provide: DOMAIN_PLUGIN_BUNDLE, useValue: ALL_DOMAIN_BUNDLES },
        HttpBootstrapService,
      ],
      exports: [HttpBootstrapService],
    };
  }
}
