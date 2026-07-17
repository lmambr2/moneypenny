/**
 * Domain → HTTP plugin mapping (PR-C3).
 * Nest modules re-export these bundles 1:1 with product domains.
 */
import { registerBrainTurn } from "../plugins/brain-turn.js";
import { registerMcp } from "../plugins/mcp.js";
import { registerOpenApi, registerOpenApiStatic } from "../plugins/openapi.js";
import { registerProtectedApi } from "../plugins/protected-api.js";
import { registerPublicRoutes } from "../plugins/public-routes.js";
import { registerSecurity } from "../plugins/security.js";
import { registerSession } from "../plugins/session.js";
import { registerStaticSpa } from "../plugins/static-spa.js";
import { registerWebSocket } from "../plugins/websocket.js";
import type { DomainPluginBundle } from "./tokens.js";

/** Full system routes for pure Express plugin path. */
export const SYSTEM_BUNDLE: DomainPluginBundle = {
  order: 10,
  name: "system",
  plugins: [registerSecurity, registerPublicRoutes, registerOpenApi],
};

/**
 * Nest path: security + swagger static only.
 * Health / openapi.json / docs HTML are Nest SystemController routes.
 */
export const SYSTEM_BUNDLE_NEST: DomainPluginBundle = {
  order: 10,
  name: "system-nest",
  plugins: [registerSecurity, registerOpenApiStatic],
};

export const MCP_BUNDLE: DomainPluginBundle = {
  order: 20,
  name: "mcp",
  plugins: [registerMcp],
};

export const SESSION_BUNDLE: DomainPluginBundle = {
  order: 30,
  name: "session",
  plugins: [registerSession],
};

export const BRAIN_BUNDLE: DomainPluginBundle = {
  order: 40,
  name: "brain",
  plugins: [registerBrainTurn],
};

/** Player + bot + music + rag + economy + users + audit (existing web/api/*). */
export const STATION_API_BUNDLE: DomainPluginBundle = {
  order: 50,
  name: "station-api",
  plugins: [registerProtectedApi],
};

export const SPA_BUNDLE: DomainPluginBundle = {
  order: 60,
  name: "spa",
  plugins: [registerStaticSpa],
};

export const WEBSOCKET_BUNDLE: DomainPluginBundle = {
  order: 70,
  name: "websocket",
  plugins: [registerWebSocket],
};

/** Express-only plugin composition (HTTP_FRAMEWORK=plugins). */
export const ALL_DOMAIN_BUNDLES: DomainPluginBundle[] = [
  SYSTEM_BUNDLE,
  MCP_BUNDLE,
  SESSION_BUNDLE,
  BRAIN_BUNDLE,
  STATION_API_BUNDLE,
  SPA_BUNDLE,
  WEBSOCKET_BUNDLE,
];

/** Nest composition: Nest controllers own system HTTP; plugins own the rest. */
export const NEST_DOMAIN_BUNDLES: DomainPluginBundle[] = [
  SYSTEM_BUNDLE_NEST,
  MCP_BUNDLE,
  SESSION_BUNDLE,
  BRAIN_BUNDLE,
  STATION_API_BUNDLE,
  SPA_BUNDLE,
  WEBSOCKET_BUNDLE,
];
