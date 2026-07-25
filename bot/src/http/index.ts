/**
 * HTTP application layer — Express plugins only (Nest removed, audit C1).
 * Domain routers remain under `web/api/*`.
 */

export { createPluginWebServer, createWebServer, orderedHttpPlugins } from "./app.js";
export { ALL_DOMAIN_BUNDLES } from "./domain-bundles.js";
export { API_OPERATIONS, buildOpenApiDocument } from "./openapi/index.js";
export { securityHeadersMiddleware } from "./plugins/security.js";
export type { HttpAppContext, HttpPlugin, WebServer, WebServerOptions } from "./types.js";
