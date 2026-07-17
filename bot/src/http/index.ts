/**
 * HTTP application layer (PR-C1/C2).
 *
 * Plugin composition lives here; domain routers remain under `web/api/*`.
 * Vue SPA still builds to `web/dist` and is served by registerStaticSpa.
 * OpenAPI: GET /api/openapi.json (REST only — no tRPC dual stack).
 */

export { createWebServer } from "./app.js";
export { buildOpenApiDocument, API_OPERATIONS } from "./openapi/index.js";
export { securityHeadersMiddleware } from "./plugins/security.js";
export type { HttpAppContext, HttpPlugin, WebServer, WebServerOptions } from "./types.js";
