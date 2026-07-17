/**
 * HTTP application layer (PR-C1).
 *
 * Plugin composition lives here; domain routers remain under `web/api/*`.
 * Vue SPA still builds to `web/dist` and is served by registerStaticSpa.
 */

export { createWebServer } from "./app.js";
export { securityHeadersMiddleware } from "./plugins/security.js";
export type { HttpAppContext, HttpPlugin, WebServer, WebServerOptions } from "./types.js";
