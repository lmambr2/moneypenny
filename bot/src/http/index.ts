/**
 * HTTP application layer (PR-C1/C2/C3).
 *
 * - C1: Express plugins
 * - C2: OpenAPI catalog at GET /api/openapi.json (REST only — no tRPC)
 * - C3: NestJS domain modules (default); HTTP_FRAMEWORK=plugins for plugin-only
 *
 * Domain routers remain under `web/api/*`.
 */

export { createPluginWebServer, createWebServer, orderedHttpPlugins } from "./app.js";
export { API_OPERATIONS, buildOpenApiDocument } from "./openapi/index.js";
export { securityHeadersMiddleware } from "./plugins/security.js";
export type { HttpAppContext, HttpPlugin, WebServer, WebServerOptions } from "./types.js";
