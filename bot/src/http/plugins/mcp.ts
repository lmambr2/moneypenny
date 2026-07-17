import express from "express";
import { loadMcpConfig } from "../../mcp/index.js";
import { createMcpRouter } from "../../mcp/server.js";
import type { HttpAppContext, HttpPlugin } from "../types.js";

/**
 * MCP (Grok Build / agent clients) — Bearer token, not session cookie.
 * Mounted outside /api so requireAuth + CSRF do not apply. See docs/mcp-server.md.
 */
export const registerMcp: HttpPlugin = (ctx: HttpAppContext) => {
  const { app, options, logger, audit } = ctx;
  const mcpConfig = loadMcpConfig();
  if (!mcpConfig.enabled) return;

  app.use(
    mcpConfig.path,
    express.json({ limit: "2mb" }),
    createMcpRouter({
      mcpConfig,
      botManager: options.botManager,
      config: options.config,
      logger,
      audit,
    }),
  );
  logger.info(
    { path: mcpConfig.path, profile: mcpConfig.defaultProfile },
    "MCP server enabled (Bearer token auth)",
  );
};
