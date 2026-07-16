/**
 * Moneypenny MCP HTTP mount (streamable HTTP, stateless).
 * See docs/mcp-server.md.
 */
import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response, Router } from "express";
import { Router as createRouter } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import type { BotManager } from "../bot/manager.js";
import type { AuditStore } from "../data/audit.js";
import type { BotConfig } from "../data/config.js";
import type { Logger } from "../logger.js";
import { createRateLimit } from "../web/middleware/rateLimit.js";
import { recordMcpToolAudit } from "./audit-hook.js";
import { authenticateMcpRequest } from "./auth.js";
import type { McpConfig } from "./config.js";
import { envelopeToToolContent } from "./result.js";
import * as tools from "./tools.js";
import type { McpContext, McpSubject, McpToolEnvelope } from "./types.js";

const APP_VERSION = "0.1.0";

export interface McpMountOptions {
  mcpConfig: McpConfig;
  botManager: BotManager;
  config: BotConfig;
  logger: Logger;
  /** Durable audit store — every tool outcome is recorded when present. */
  audit?: AuditStore;
}

type ToolFn = (args: Record<string, unknown>, ctx: McpContext) => Promise<McpToolEnvelope>;

function makeCtx(
  opts: McpMountOptions,
  subject: McpSubject,
  requestId: string,
): McpContext {
  return {
    config: opts.mcpConfig,
    botManager: opts.botManager,
    logger: opts.logger,
    subject,
    startedAt: Date.now(),
    requestId,
  };
}

/**
 * Run one MCP tool through the real handler and record audit.
 * Exported for tests (same path the HTTP transport uses).
 */
export async function runMcpTool(
  opts: McpMountOptions,
  subject: McpSubject,
  name: string,
  fn: ToolFn,
  args: Record<string, unknown>,
): Promise<{ content: ReturnType<typeof envelopeToToolContent>["content"]; isError?: boolean; envelope: McpToolEnvelope }> {
  const requestId = randomUUID();
  const ctx = makeCtx(opts, subject, requestId);
  let envelope: McpToolEnvelope;
  try {
    envelope = await fn(args, ctx);
  } catch (err: unknown) {
    opts.logger.error({ err, tool: name, component: "mcp" }, "MCP tool threw");
    const message = err instanceof Error ? err.message : "internal error";
    envelope = {
      ok: false,
      code: "INTERNAL",
      message,
      data: null,
      meta: { duration_ms: Date.now() - ctx.startedAt, request_id: requestId },
    };
  }
  opts.logger.info(
    {
      component: "mcp",
      tool: name,
      ok: envelope.ok,
      code: envelope.code,
      ms: envelope.meta.duration_ms,
      subject: subject.invokerUid,
      profile: subject.rightsProfile,
      botId: envelope.meta.bot_id,
    },
    "MCP tool",
  );
  recordMcpToolAudit(opts.audit, subject, name, envelope);
  const out = envelopeToToolContent(envelope);
  return { ...out, envelope };
}

/** Optional string bot_id shared by most tools. */
const botIdField = z.string().optional().describe("Bot instance id (default: first / MCP_BOT_ID)");

function createMcpServerForRequest(opts: McpMountOptions, subject: McpSubject): McpServer {
  const server = new McpServer({
    name: "moneypenny",
    version: APP_VERSION,
  });

  const reg = (
    name: string,
    description: string,
    schema: z.ZodRawShape,
    fn: ToolFn,
  ) => {
    server.registerTool(
      name,
      { description, inputSchema: schema },
      async (args) => {
        const { content, isError } = await runMcpTool(
          opts,
          subject,
          name,
          fn,
          (args ?? {}) as Record<string, unknown>,
        );
        return { content, isError };
      },
    );
  };

  reg(
    "status_health",
    "Health of the Moneypenny bot host and connected bot instances.",
    {},
    (a, c) => tools.statusHealth(a, c, APP_VERSION),
  );

  reg(
    "status_now_playing",
    "Current track, playback state, volume, and queue size.",
    { bot_id: botIdField },
    tools.statusNowPlaying,
  );

  reg(
    "status_queue",
    "List upcoming tracks in the music queue.",
    {
      bot_id: botIdField,
      limit: z.number().int().min(1).max(100).optional().describe("Max items (default 30)"),
    },
    tools.statusQueue,
  );

  reg(
    "status_radio",
    "Autonomous radio / auto-DJ director status.",
    {},
    tools.statusRadio,
  );

  reg(
    "status_rag",
    "Doctrine knowledge base / TurboVec RAG substrate status.",
    {},
    (a, c) => tools.statusRag(a, c, opts.config),
  );

  const playSchema = {
    query: z.string().describe("Search query or media URL"),
    platform: z
      .enum(["local", "youtube", "stream"])
      .optional()
      .describe("Force provider; omit for default resolve order"),
    bot_id: botIdField,
    dry_run: z.boolean().optional().describe("If true, do not mutate queue"),
  };

  reg(
    "music_play",
    "Play a track or URL on the TeamSpeak music bot (local first, then YouTube/stream).",
    playSchema,
    tools.musicPlay,
  );

  reg(
    "music_add",
    "Add a track or URL to the queue without interrupting the current song.",
    playSchema,
    tools.musicAdd,
  );

  reg(
    "music_play_next",
    "Queue a track to play immediately after the current song.",
    playSchema,
    tools.musicPlayNext,
  );

  reg("music_skip", "Skip to the next track in the queue.", { bot_id: botIdField }, tools.musicSkip);
  reg("music_pause", "Pause playback.", { bot_id: botIdField }, tools.musicPause);
  reg("music_resume", "Resume paused playback.", { bot_id: botIdField }, tools.musicResume);

  reg(
    "music_ban",
    "Ban a track from search/auto-DJ (empty query = current track). High-impact: pass confirm:true.",
    {
      query: z.string().optional().describe("Title/artist or fingerprint; omit for current track"),
      confirm: z.boolean().optional().describe("Required true when MCP_REQUIRE_CONFIRM is on (default)"),
      bot_id: botIdField,
    },
    tools.musicBan,
  );

  reg(
    "music_unban",
    "Remove a track from the playback ban list.",
    {
      query: z.string().describe("Title/artist or ban entry to remove"),
      bot_id: botIdField,
    },
    tools.musicUnban,
  );

  reg(
    "music_stop",
    "Stop playback (admin). High-impact: pass confirm:true.",
    {
      confirm: z.boolean().optional(),
      bot_id: botIdField,
    },
    tools.musicStop,
  );
  reg(
    "music_clear",
    "Clear the queue and stop (admin). High-impact: pass confirm:true.",
    {
      confirm: z.boolean().optional(),
      bot_id: botIdField,
    },
    tools.musicClear,
  );

  reg(
    "music_volume",
    "Set playback volume 0–100 (admin).",
    {
      volume: z.number().min(0).max(100).describe("Volume percent 0–100"),
      bot_id: botIdField,
    },
    tools.musicVolume,
  );

  reg(
    "music_mode",
    "Set queue play mode: seq | loop | random | rloop (admin).",
    {
      mode: z.enum(["seq", "loop", "random", "rloop"]),
      bot_id: botIdField,
    },
    tools.musicMode,
  );

  reg(
    "music_history",
    "Recent play history for the bot.",
    {
      bot_id: botIdField,
      limit: z.number().int().min(1).max(200).optional(),
    },
    tools.musicHistory,
  );

  reg(
    "radio_set",
    "Radio / auto-DJ control (same as !radio <args>). Empty args = status. on/off and power ops need admin.",
    {
      args: z
        .string()
        .optional()
        .describe("Subcommand string, e.g. 'on', 'off', 'status', 'profile lobby'"),
      bot_id: botIdField,
      dry_run: z.boolean().optional(),
    },
    tools.radioSet,
  );

  reg(
    "doctrine_list",
    "List doctrine documents in the knowledge base registry.",
    { bot_id: botIdField },
    tools.doctrineList,
  );

  reg(
    "doctrine_reindex",
    "Re-embed doctrine into the vector store (all docs or selected sources).",
    {
      sources: z.array(z.string()).optional().describe("Optional .md paths; omit to reindex all"),
      source: z.string().optional().describe("Single source shorthand"),
      bot_id: botIdField,
      dry_run: z.boolean().optional(),
    },
    tools.doctrineReindex,
  );

  reg(
    "doctrine_ingest_status",
    "File-drop / doctrine ingest status (!ingeststatus).",
    { bot_id: botIdField },
    tools.doctrineIngestStatus,
  );

  reg(
    "memory_remember",
    "Store a private !remember fact for the MCP invoker subject.",
    {
      fact: z.string().describe("Fact text to remember"),
      bot_id: botIdField,
    },
    tools.memoryRemember,
  );

  reg(
    "memory_recall",
    "List private !remember facts for the MCP invoker subject.",
    { bot_id: botIdField },
    tools.memoryRecall,
  );

  reg(
    "memory_forget",
    "Forget a private fact by recall index or 'all'.",
    {
      which: z.string().describe("1-based index from memory_recall, or 'all'"),
      bot_id: botIdField,
    },
    tools.memoryForget,
  );

  reg(
    "rag_search",
    "Semantic search over doctrine (chunks only, no LLM answer).",
    {
      q: z.string().describe("Search query"),
      top_k: z.number().int().min(1).max(20).optional(),
      allowed_classifications: z.array(z.string()).optional(),
      bot_id: botIdField,
    },
    tools.ragSearch,
  );

  reg(
    "rag_ask",
    "Ask a question grounded in org doctrine (RAG + bot LLM). Returns answer and sources.",
    {
      question: z.string().describe("Natural language question"),
      include_sources: z.boolean().optional().describe("Include source citations (default true)"),
      bot_id: botIdField,
    },
    tools.ragAsk,
  );

  reg(
    "harness_turn",
    "Admin harness cockpit turn (ask or intent+tools). Prefer structured music_* tools when the song is already known.",
    {
      question: z.string(),
      mode: z.enum(["ask", "intent"]).optional(),
      dry_run: z.boolean().optional(),
      allow_dangerous: z.boolean().optional(),
      bot_id: botIdField,
    },
    tools.harnessTurn,
  );

  reg(
    "harness_turns",
    "List recent harness cockpit turns (ring buffer).",
    {
      limit: z.number().int().min(1).max(50).optional(),
      bot_id: botIdField,
    },
    tools.harnessTurns,
  );

  // ─── Phase 3 ────────────────────────────────────────────────────────────
  reg(
    "econ_run",
    "Org economy command (mine/refine/craft/econ/trade) — same as !mine etc.",
    {
      command: z.enum(["mine", "refine", "craft", "econ", "trade"]),
      args: z.string().optional().describe("Arguments after the command name"),
      bot_id: botIdField,
      dry_run: z.boolean().optional(),
    },
    tools.econRun,
  );

  reg(
    "workorder_run",
    "Work-order shopping list (!workorder <args>). clear-all needs admin profile.",
    {
      args: z.string().optional().describe("Subcommand / materials text"),
      bot_id: botIdField,
      dry_run: z.boolean().optional(),
    },
    tools.workorderRun,
  );

  reg(
    "work_items",
    "List aggregated work-order materials (!work-items).",
    { bot_id: botIdField },
    tools.workItems,
  );

  reg(
    "generate_music",
    "ACE-Step music generation (!generate). Returns clear error if not configured.",
    {
      prompt: z.string().describe("Generation prompt / style description"),
      bot_id: botIdField,
      dry_run: z.boolean().optional(),
    },
    tools.generateMusic,
  );

  if (opts.mcpConfig.enableModeration) {
    reg(
      "mod_mute",
      "Mute a client in channel (requires MCP_ENABLE_MODERATION=1). High-impact: confirm:true required.",
      {
        target: z.string().describe("Nickname or client id"),
        confirm: z.boolean().optional(),
        bot_id: botIdField,
      },
      tools.modMute,
    );
    reg(
      "mod_kick",
      "Kick a client from channel (requires MCP_ENABLE_MODERATION=1). High-impact: confirm:true required.",
      {
        target: z.string().describe("Nickname or client id"),
        confirm: z.boolean().optional(),
        bot_id: botIdField,
      },
      tools.modKick,
    );
  }

  // High-impact music tools: document confirm on schemas already registered
  // (handlers enforce NEEDS_CONFIRMATION).

  return server;
}

/** Always-registered tool names (Phase 1–3 minus optional moderation). */
export const MCP_TOOL_NAMES_BASE = [
  "status_health",
  "status_now_playing",
  "status_queue",
  "status_radio",
  "status_rag",
  "music_play",
  "music_add",
  "music_play_next",
  "music_skip",
  "music_pause",
  "music_resume",
  "music_ban",
  "music_unban",
  "music_stop",
  "music_clear",
  "music_volume",
  "music_mode",
  "music_history",
  "radio_set",
  "doctrine_list",
  "doctrine_reindex",
  "doctrine_ingest_status",
  "memory_remember",
  "memory_recall",
  "memory_forget",
  "rag_search",
  "rag_ask",
  "harness_turn",
  "harness_turns",
  "econ_run",
  "workorder_run",
  "work_items",
  "generate_music",
] as const;

export const MCP_MODERATION_TOOLS = ["mod_mute", "mod_kick"] as const;

/** Stable list for tests/docs. Moderation tools listed only when flag is on at runtime. */
export const MCP_TOOL_NAMES = [...MCP_TOOL_NAMES_BASE, ...MCP_MODERATION_TOOLS] as const;

export function mcpToolNamesForConfig(enableModeration: boolean): readonly string[] {
  return enableModeration
    ? MCP_TOOL_NAMES
    : MCP_TOOL_NAMES_BASE;
}

/**
 * Express router for MCP streamable HTTP (stateless per request).
 * Mount at mcpConfig.path (default `/mcp`). Outside `/api` so session auth does not apply.
 */
export function createMcpRouter(opts: McpMountOptions): Router {
  const router = createRouter();
  const log = opts.logger.child({ component: "mcp" });

  const rateLimit = createRateLimit({
    capacity: 60,
    refillPerSec: 10,
    message: (waitSec) => `MCP rate limited. Retry in ${waitSec}s.`,
  });

  const requireMcpAuth: RequestHandler = (req, res, next) => {
    const subject = authenticateMcpRequest(req, opts.mcpConfig);
    if (!subject) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: invalid or missing Bearer token" },
        id: null,
      });
      return;
    }
    (req as Request & { mcpSubject: McpSubject }).mcpSubject = subject;
    next();
  };

  const handlePost = async (req: Request, res: Response) => {
    const subject = (req as Request & { mcpSubject: McpSubject }).mcpSubject;
    const server = createMcpServerForRequest(opts, subject);
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      log.error({ err: error }, "MCP request failed");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  router.use(rateLimit);
  router.use(requireMcpAuth);

  // Stateless: only POST is meaningful for initialize + tools/call.
  router.post("/", handlePost);
  router.get("/", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST (stateless streamable HTTP)." },
      id: null,
    });
  });
  router.delete("/", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless; no sessions to delete)." },
      id: null,
    });
  });

  return router;
}

/** Mount MCP on an Express app when enabled. */
export function mountMcp(
  app: { use: (path: string, ...handlers: RequestHandler[]) => unknown },
  opts: McpMountOptions,
): void {
  if (!opts.mcpConfig.enabled) {
    opts.logger.info("MCP server disabled (set MCP_ENABLED=1 and MCP_TOKEN)");
    return;
  }
  const path = opts.mcpConfig.path;
  // JSON body for MCP JSON-RPC (not under /api auth stack).
  // express.json is applied by caller or we import express here.
  app.use(path, createMcpRouter(opts) as unknown as RequestHandler);
  opts.logger.info(
    { path, profile: opts.mcpConfig.defaultProfile },
    "MCP server enabled (Bearer token auth)",
  );
}
