import { Module } from "@nestjs/common";

/**
 * Domain HTTP modules (PR-C3) — ownership markers for Nest composition.
 * Plugin bundles are registered centrally in NestHttpAppModule (Nest 11
 * multi-providers are awkward with strict Provider typing; domain modules
 * still map 1:1 to product surfaces for DI / future controllers).
 */

/** System: security headers, health, OpenAPI. */
@Module({})
export class SystemHttpModule {}

/** MCP Bearer surface. */
@Module({})
export class McpHttpModule {}

/** Session login / CSRF. */
@Module({})
export class SessionHttpModule {}

/** Brain POST /v1/turn. */
@Module({})
export class BrainHttpModule {}

/**
 * Station domain API: player, bot, music, rag, economy, users, audit
 * (routers live under web/api/* — Nest owns composition only).
 */
@Module({})
export class StationApiHttpModule {}

/** Vue SPA static. */
@Module({})
export class SpaHttpModule {}

/** WebSocket /ws. */
@Module({})
export class WebsocketHttpModule {}
