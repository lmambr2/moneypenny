/** Env-driven MCP server settings (docs/mcp-server.md §15). */

export type McpProfile = "readonly" | "dj" | "admin";

export interface McpConfig {
  enabled: boolean;
  token: string;
  path: string;
  botId: string | null;
  defaultProfile: McpProfile;
  allowRawCommand: boolean;
  enableModeration: boolean;
  /** When true (default), ban/stop/clear/mod tools need args.confirm === true. */
  requireConfirm: boolean;
  invokerName: string;
  invokerUid: string;
}

function envTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function parseProfile(raw: string | undefined): McpProfile {
  const p = (raw ?? "admin").trim().toLowerCase();
  if (p === "readonly" || p === "dj" || p === "admin") return p;
  return "admin";
}

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const token = (env.MCP_TOKEN ?? "").trim();
  const enabled = envTruthy(env.MCP_ENABLED) && token.length > 0;
  let path = (env.MCP_PATH ?? "/mcp").trim() || "/mcp";
  if (!path.startsWith("/")) path = `/${path}`;
  // Strip trailing slash except root
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  // Default ON for safety polish; set MCP_REQUIRE_CONFIRM=0 to disable.
  const requireConfirmRaw = env.MCP_REQUIRE_CONFIRM;
  const requireConfirm =
    requireConfirmRaw === undefined || requireConfirmRaw === ""
      ? true
      : envTruthy(requireConfirmRaw);

  return {
    enabled,
    token,
    path,
    botId: (env.MCP_BOT_ID ?? "").trim() || null,
    defaultProfile: parseProfile(env.MCP_DEFAULT_PROFILE),
    allowRawCommand: envTruthy(env.MCP_ALLOW_RAW_COMMAND),
    enableModeration: envTruthy(env.MCP_ENABLE_MODERATION),
    requireConfirm,
    invokerName: (env.MCP_INVOKER_NAME ?? "grok-build").trim() || "grok-build",
    invokerUid: (env.MCP_INVOKER_UID ?? "mcp:service").trim() || "mcp:service",
  };
}
