/** Nest DI tokens for station HTTP (PR-C3). */
export const WEB_OPTIONS = Symbol("WEB_OPTIONS");
export const HTTP_CONTEXT = Symbol("HTTP_CONTEXT");

/** Multi-provider: domain plugin bundles ordered at bootstrap. */
export const DOMAIN_PLUGIN_BUNDLE = "DOMAIN_PLUGIN_BUNDLE";

export interface DomainPluginBundle {
  /** Lower runs first (security → … → websocket). */
  order: number;
  /** Domain name for logs / diagnostics. */
  name: string;
  plugins: Array<(ctx: import("../types.js").HttpAppContext) => void>;
}
