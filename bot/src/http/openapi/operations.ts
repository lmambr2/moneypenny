/**
 * REST operation catalog (PR-C2).
 *
 * Single source of truth for OpenAPI paths. Keep REST only — do not add tRPC
 * or a parallel RPC surface (architecture Phase C2).
 *
 * Auth:
 * - public: no session
 * - session: cookie session (requireAuth)
 * - admin: session + role admin
 * - sessionOrAdminNote: session; some actions re-check admin inside handler
 */

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";
export type AuthLevel = "public" | "session" | "admin";

export interface ApiOperation {
  method: HttpMethod;
  /** Full path with OpenAPI-style `{param}` placeholders. */
  path: string;
  summary: string;
  tags: string[];
  auth: AuthLevel;
  /** Optional request body JSON schema fragment (OpenAPI schema object). */
  body?: Record<string, unknown>;
}

function op(
  method: HttpMethod,
  path: string,
  summary: string,
  tags: string[],
  auth: AuthLevel,
  body?: Record<string, unknown>,
): ApiOperation {
  return body ? { method, path, summary, tags, auth, body } : { method, path, summary, tags, auth };
}

const jsonObject = (props: Record<string, unknown>, required?: string[]) => ({
  type: "object",
  properties: props,
  ...(required?.length ? { required } : {}),
  additionalProperties: true,
});

/** Catalog of station REST endpoints (cookie session API — not MCP). */
export const API_OPERATIONS: ApiOperation[] = [
  // ── Public ───────────────────────────────────────────────────────────────
  op("get", "/api/health", "Liveness probe", ["system"], "public"),
  op("get", "/api/config/public-url", "Configured public WebUI URL", ["system"], "public"),
  op("get", "/api/openapi.json", "OpenAPI 3 document for this REST API", ["system"], "public"),
  op(
    "post",
    "/v1/turn",
    "Brain turn (propose tools; optional executeTools dispose)",
    ["brain"],
    "admin",
    jsonObject(
      {
        text: { type: "string" },
        channel: { type: "string", enum: ["dashboard", "teamspeak", "voice"] },
        mode: { type: "string", enum: ["ask", "intent", "delegate"] },
        clientTurnId: { type: "string" },
        executeTools: { type: "boolean" },
        dryRun: { type: "boolean" },
      },
      ["text"],
    ),
  ),

  // ── Session (pre-auth + cookie) ──────────────────────────────────────────
  op("get", "/api/session/needs-setup", "Whether first-run admin setup is required", ["session"], "public"),
  op(
    "post",
    "/api/session/setup",
    "Create first admin user (only when needs-setup)",
    ["session"],
    "public",
    jsonObject({ username: { type: "string" }, password: { type: "string" } }, ["username", "password"]),
  ),
  op(
    "post",
    "/api/session/login",
    "Login; sets httpOnly session cookie",
    ["session"],
    "public",
    jsonObject({ username: { type: "string" }, password: { type: "string" } }, ["username", "password"]),
  ),
  op("post", "/api/session/logout", "Clear session cookie", ["session"], "public"),
  op("get", "/api/session/me", "Current user", ["session"], "session"),
  op(
    "post",
    "/api/session/change-password",
    "Change password for current user",
    ["session"],
    "session",
    jsonObject({ currentPassword: { type: "string" }, newPassword: { type: "string" } }),
  ),

  // ── Auth (YouTube provider status) ───────────────────────────────────────
  op("get", "/api/auth/status", "YouTube / provider auth availability", ["auth"], "session"),

  // ── Player ───────────────────────────────────────────────────────────────
  op("post", "/api/player/{botId}/play", "Play query or URL", ["player"], "session"),
  op("post", "/api/player/{botId}/add", "Queue query or URL", ["player"], "session"),
  op("post", "/api/player/{botId}/pause", "Pause", ["player"], "session"),
  op("post", "/api/player/{botId}/resume", "Resume", ["player"], "session"),
  op("post", "/api/player/{botId}/next", "Skip / next", ["player"], "session"),
  op("post", "/api/player/{botId}/prev", "Previous", ["player"], "session"),
  op("post", "/api/player/{botId}/stop", "Stop playback", ["player"], "admin"),
  op("post", "/api/player/{botId}/clear", "Clear queue", ["player"], "admin"),
  op("post", "/api/player/{botId}/volume", "Set volume", ["player"], "session"),
  op("post", "/api/player/{botId}/mode", "Playback mode", ["player"], "admin"),
  op("get", "/api/player/{botId}/elapsed", "Elapsed time", ["player"], "session"),
  op("post", "/api/player/{botId}/seek", "Seek", ["player"], "admin"),
  op("get", "/api/player/{botId}/queue", "Queue list", ["player"], "session"),
  op("delete", "/api/player/{botId}/queue/{index}", "Remove queue item", ["player"], "admin"),
  op("post", "/api/player/{botId}/play-at", "Play queue index", ["player"], "admin"),
  op("post", "/api/player/{botId}/playlist", "Queue playlist", ["player"], "session"),
  op("post", "/api/player/{botId}/play-playlist", "Play playlist", ["player"], "session"),
  op("post", "/api/player/{botId}/play-album", "Play album", ["player"], "session"),
  op("post", "/api/player/{botId}/play-song", "Play library song", ["player"], "session"),
  op("post", "/api/player/{botId}/play-next-song", "Play song next", ["player"], "session"),
  op("post", "/api/player/{botId}/add-song", "Add library song", ["player"], "session"),
  op("post", "/api/player/{botId}/add-by-id", "Add by provider id", ["player"], "session"),
  op("get", "/api/player/{botId}/profile", "Bot profile", ["player"], "session"),
  op("put", "/api/player/{botId}/profile", "Update bot profile", ["player"], "admin"),
  op("get", "/api/player/{botId}/history", "Play history", ["player"], "session"),

  // ── Bot manager / settings ───────────────────────────────────────────────
  op("get", "/api/bot/settings", "Bot settings bundle", ["bot"], "admin"),
  op("post", "/api/bot/settings", "Update bot settings", ["bot"], "admin"),
  op("get", "/api/bot/voice/status", "Voice pipeline status", ["bot"], "admin"),
  op("post", "/api/bot/voice/test", "Voice TTS smoke", ["bot"], "admin"),
  op("get", "/api/bot/voice/under-music-check", "Under-music voice check", ["bot"], "admin"),
  op("post", "/api/bot/memory/sync", "Sync memory bridge", ["bot"], "admin"),
  op("get", "/api/bot/memory/status", "Memory status", ["bot"], "admin"),
  op("get", "/api/bot/memory/scopes", "Memory scopes", ["bot"], "admin"),
  op("get", "/api/bot/memory/private", "Private memory entries", ["bot"], "admin"),
  op("get", "/api/bot/ace-step/status", "ACE-Step status", ["bot"], "admin"),
  op("post", "/api/bot/ace-step/generate", "ACE-Step generate", ["bot"], "admin"),
  op("get", "/api/bot/radio/status", "Radio director status", ["bot"], "admin"),
  op("post", "/api/bot/radio/test-bumper", "Test radio bumper", ["bot"], "admin"),
  op("post", "/api/bot/radio/clear-bumper-cache", "Clear bumper cache", ["bot"], "admin"),
  op("post", "/api/bot/radio/prewarm-bumpers", "Prewarm bumpers", ["bot"], "admin"),
  op("get", "/api/bot/rag/status", "RAG status (bot view)", ["bot"], "admin"),
  op("post", "/api/bot/rag/query", "RAG query (bot view)", ["bot"], "admin"),
  op("post", "/api/bot/rag/eval", "RAG eval harness", ["bot"], "admin"),
  op("get", "/api/bot/stream-bridge/status", "Stream bridge status", ["bot"], "admin"),
  op("get", "/api/bot/llm/status", "LLM status", ["bot"], "admin"),
  op("post", "/api/bot/llm/ask", "LLM ask", ["bot"], "admin"),
  op("get", "/api/bot/rights/debug", "Rights debug", ["bot"], "admin"),
  op("post", "/api/bot/harness/ask", "Harness turn", ["bot"], "admin"),
  op("get", "/api/bot/harness/turns", "Harness turn history", ["bot"], "admin"),
  op("get", "/api/bot/org-kg", "Org knowledge graph get", ["bot"], "admin"),
  op("post", "/api/bot/org-kg", "Org knowledge graph set", ["bot"], "admin"),
  op("get", "/api/bot/ops/status", "Ops status plugins", ["bot"], "admin"),
  op("get", "/api/bot/recordings", "List recordings", ["bot"], "admin"),
  op("post", "/api/bot/recordings", "Upload recording", ["bot"], "admin"),
  op("get", "/api/bot/recordings/{name}", "Get recording", ["bot"], "admin"),
  op("delete", "/api/bot/recordings/{name}", "Delete recording", ["bot"], "admin"),
  op("get", "/api/bot/live", "Live status snapshot", ["bot"], "session"),
  op("get", "/api/bot", "List bot instances", ["bot"], "session"),
  op("post", "/api/bot", "Create bot instance", ["bot"], "admin"),
  op("get", "/api/bot/{id}", "Get bot instance", ["bot"], "session"),
  op("put", "/api/bot/{id}", "Update bot instance", ["bot"], "admin"),
  op("delete", "/api/bot/{id}", "Delete bot instance", ["bot"], "admin"),
  op("get", "/api/bot/{id}/config", "Bot instance config", ["bot"], "admin"),
  op("get", "/api/bot/{id}/avatar", "Bot avatar", ["bot"], "session"),
  op("put", "/api/bot/{id}/avatar", "Set bot avatar", ["bot"], "admin"),
  op("delete", "/api/bot/{id}/avatar", "Clear bot avatar", ["bot"], "admin"),
  op("post", "/api/bot/{id}/start", "Start bot", ["bot"], "admin"),
  op("post", "/api/bot/{id}/stop", "Stop bot", ["bot"], "admin"),

  // ── Music library ────────────────────────────────────────────────────────
  op("get", "/api/music/resolve", "Resolve URL/query to playable", ["music"], "session"),
  op("get", "/api/music/search", "Search provider", ["music"], "session"),
  op("get", "/api/music/search/all", "Search all providers", ["music"], "session"),
  op("get", "/api/music/library", "Local library list", ["music"], "session"),
  op("get", "/api/music/blacklist", "Playback blacklist", ["music"], "admin"),
  op("post", "/api/music/blacklist", "Add blacklist entry", ["music"], "admin"),
  op("delete", "/api/music/blacklist/{id}", "Remove blacklist entry", ["music"], "admin"),
  op("delete", "/api/music/tracks/{id}", "Delete local track", ["music"], "admin"),
  op("get", "/api/music/song/{id}", "Song detail", ["music"], "session"),
  op("get", "/api/music/playlist/{id}", "Playlist detail", ["music"], "session"),
  op("get", "/api/music/recommend/playlists", "Recommended playlists", ["music"], "session"),
  op("get", "/api/music/album/{id}", "Album detail", ["music"], "session"),
  op("get", "/api/music/lyrics/{id}", "Lyrics", ["music"], "session"),
  op("get", "/api/music/quality", "Stream quality setting", ["music"], "session"),
  op("post", "/api/music/quality", "Set stream quality", ["music"], "session"),
  op("post", "/api/music/upload", "Upload local track (multipart)", ["music"], "session"),
  op("get", "/api/music/stats", "Library stats", ["music"], "session"),
  op("post", "/api/music/refresh", "Refresh library index", ["music"], "admin"),
  op("get", "/api/music/analyze/status", "Radio analyzer status", ["music"], "admin"),
  op("post", "/api/music/analyze", "Analyze tracks", ["music"], "admin"),
  op("patch", "/api/music/tracks/tags/bulk", "Bulk tag edit", ["music"], "session"),
  op("get", "/api/music/tracks/{id}/tags", "Track tags", ["music"], "session"),
  op("patch", "/api/music/tracks/{id}/tags", "Edit track tags", ["music"], "session"),
  op("post", "/api/music/tracks/{id}/tags/guess", "LLM guess tags", ["music"], "session"),
  op("post", "/api/music/tracks/{id}/rating", "Rate track", ["music"], "session"),
  op("delete", "/api/music/tracks/{id}/rating", "Clear rating", ["music"], "session"),

  // ── RAG / doctrine ───────────────────────────────────────────────────────
  op("post", "/api/rag/ingest", "Ingest document", ["rag"], "admin"),
  op("post", "/api/rag/query", "Vector query", ["rag"], "admin"),
  op("get", "/api/rag/doctrine", "List doctrine sources", ["rag"], "admin"),
  op("get", "/api/rag/doctrine/hygiene", "Doctrine hygiene report", ["rag"], "admin"),
  op("get", "/api/rag/doctrine/export/capabilities", "Export capabilities", ["rag"], "admin"),
  op("get", "/api/rag/doctrine/{source}/export", "Export doctrine source", ["rag"], "admin"),
  op("post", "/api/rag/doctrine/new", "Create doctrine doc", ["rag"], "admin"),
  op("get", "/api/rag/doctrine/{source}", "Get doctrine body", ["rag"], "admin"),
  op("put", "/api/rag/doctrine/{source}", "Update doctrine body", ["rag"], "admin"),
  op("post", "/api/rag/doctrine", "Upload doctrine (multipart)", ["rag"], "admin"),
  op("delete", "/api/rag/doctrine/{source}", "Delete doctrine source", ["rag"], "admin"),
  op("post", "/api/rag/doctrine/reindex", "Reindex doctrine", ["rag"], "admin"),
  op("post", "/api/rag/doctrine/reformat", "Normalize doctrine formatting", ["rag"], "admin"),

  // ── Economy ──────────────────────────────────────────────────────────────
  op("get", "/api/economy/overview", "Economy dashboard overview", ["economy"], "session"),
  op("get", "/api/economy/ores", "Ore catalog", ["economy"], "session"),
  op("get", "/api/economy/boxes", "Boxes catalog", ["economy"], "session"),
  op("get", "/api/economy/methods", "Methods catalog", ["economy"], "session"),
  op("get", "/api/economy/mine", "Mine planner", ["economy"], "session"),
  op("get", "/api/economy/refine", "Refine planner", ["economy"], "session"),
  op("get", "/api/economy/blueprints", "Blueprints", ["economy"], "session"),
  op("get", "/api/economy/craft", "Craft planner", ["economy"], "session"),
  op("get", "/api/economy/commodities", "Commodities", ["economy"], "session"),
  op("get", "/api/economy/prices", "Prices", ["economy"], "session"),
  op("get", "/api/economy/workorders", "List work orders", ["economy"], "session"),
  op("post", "/api/economy/workorders", "Create work order", ["economy"], "session"),
  op("delete", "/api/economy/workorders/{id}", "Delete work order", ["economy"], "session"),
  op("delete", "/api/economy/workorders", "Clear work orders", ["economy"], "admin"),
  op("get", "/api/economy/trade/ships", "Trade ships", ["economy"], "session"),
  op("post", "/api/economy/trade/routes", "Trade routes", ["economy"], "session"),
  op("post", "/api/economy/trade/buyers", "Trade buyers", ["economy"], "session"),
  op("post", "/api/economy/trade/itinerary", "Trade itinerary", ["economy"], "session"),
  op("post", "/api/economy/trade/circuit", "Trade circuit", ["economy"], "session"),
  op("get", "/api/economy/cache", "Economy cache status", ["economy"], "session"),
  op("post", "/api/economy/cache/refresh", "Refresh economy cache", ["economy"], "session"),

  // ── Users / audit (admin) ────────────────────────────────────────────────
  op("get", "/api/users", "List users", ["users"], "admin"),
  op("post", "/api/users", "Create user", ["users"], "admin"),
  op("delete", "/api/users/{id}", "Delete user", ["users"], "admin"),
  op("post", "/api/users/{id}/reset-password", "Reset user password", ["users"], "admin"),
  op("patch", "/api/users/{id}/role", "Change user role", ["users"], "admin"),
  op("get", "/api/audit", "Audit log", ["audit"], "admin"),
];

export function operationKey(op: ApiOperation): string {
  return `${op.method.toUpperCase()} ${op.path}`;
}
