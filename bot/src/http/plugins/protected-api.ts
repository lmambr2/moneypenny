import express from "express";
import { createAuditRouter } from "../../web/api/audit.js";
import { createAuthRouter } from "../../web/api/auth.js";
import { createBotRouter } from "../../web/api/bot.js";
import { createEconomyRouter } from "../../web/api/economy.js";
import { createMusicRouter } from "../../web/api/music.js";
import { createPlayerRouter } from "../../web/api/player.js";
import { createRagRouter } from "../../web/api/rag.js";
import { createUsersRouter } from "../../web/api/users.js";
import { requireAdmin } from "../../web/middleware/requireAdmin.js";
import { createRequireAuth } from "../../web/middleware/requireAuth.js";
import type { HttpAppContext, HttpPlugin } from "../types.js";

/**
 * Authenticated REST surface: requireAuth, scoped JSON parsers, domain routers.
 * Route modules stay under `web/api/*` (domain ownership); this plugin only mounts.
 */
export const registerProtectedApi: HttpPlugin = (ctx: HttpAppContext) => {
  const { app, options, users, sessions, audit, logger } = ctx;

  const requireAuth = createRequireAuth(sessions);
  app.use("/api", requireAuth);

  // Authed-only body parsing. Doctrine editor up to 15 MiB; recordings ~70 MB envelope.
  // Larger parsers first so the global 2mb parser skips already-parsed bodies.
  app.use("/api/rag", express.json({ limit: "16mb" }));
  app.use("/api/bot/recordings", express.json({ limit: "70mb" }));
  app.use("/api", express.json({ limit: "2mb" }));

  app.use(
    "/api/bot",
    createBotRouter(
      options.botManager,
      options.config,
      options.configPath,
      logger,
      options.database,
      options.avatarStore,
      audit,
    ),
  );
  app.use(
    "/api/music",
    createMusicRouter(
      options.localProvider,
      options.youtubeProvider,
      options.streamProvider,
      logger,
      {
        tagStore: options.tagStore,
        playbackBlacklist: options.playbackBlacklist,
        radioAnalyzer: options.radioAnalyzer,
        getRadioConfig: () => options.config.radio,
        canEditTags: async (user) => {
          const bot = options.botManager.getAllBots()[0];
          if (!bot) return false;
          return bot.canWebUserRunCommand(user, "radio.tags");
        },
        askLlm: async (question) => {
          const bot = options.botManager.getAllBots()[0];
          if (!bot) return null;
          return bot.askLlm(question);
        },
      },
    ),
  );
  app.use("/api/player", createPlayerRouter(options.botManager, logger, options.database));
  app.use("/api/auth", createAuthRouter(options.youtubeProvider, logger));
  app.use("/api/economy", createEconomyRouter({ logger, audit }));
  app.use("/api/users", requireAdmin, createUsersRouter(users, sessions, audit, logger));
  app.use("/api/audit", requireAdmin, createAuditRouter(audit));
  if (options.retrieval && options.doctrine) {
    app.use("/api/rag", requireAdmin, createRagRouter(options.retrieval, options.doctrine, logger));
  }
};
