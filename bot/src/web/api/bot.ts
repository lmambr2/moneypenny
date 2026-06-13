import { Router } from "express";
import type { BotManager } from "../../bot/manager.js";
import type { BotConfig } from "../../data/config.js";
import { saveConfig } from "../../data/config.js";
import type { Logger } from "../../logger.js";
import type { BotDatabase } from "../../data/database.js";
import type { AvatarStore } from "../../data/avatars.js";
import type { RightsConfig } from "../../rights/index.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

export function createBotRouter(
  botManager: BotManager,
  config: BotConfig,
  configPath: string,
  logger: Logger,
  botDb: BotDatabase,
  avatarStore: AvatarStore,
): Router {
  const router = Router();

  // ─── Global settings ─────────────────────────────────────
  // NOTE: these MUST be registered before "/:id" — otherwise GET /settings is
  // captured by the "/:id" param route (id="settings") and never reaches here.

  // GET /api/bot/settings — read global bot behavior + AI/permission settings.
  router.get("/settings", (_req, res) => {
    res.json({
      idleTimeoutMinutes: config.idleTimeoutMinutes ?? 0,
      llmEnabled: config.llmEnabled ?? false,
      llmUrl: config.llmUrl ?? "",
      llmModel: config.llmModel ?? "",
      llmSystemPrompt: config.llmSystemPrompt ?? "",
      llmTemperature: config.llmTemperature ?? 0.2,
      roastEnabled: config.roastEnabled ?? false,
      roastMinPresent: config.roastMinPresent ?? 3,
      roastCooldownMinutes: config.roastCooldownMinutes ?? 180,
      ragEnabled: config.ragEnabled ?? false,
      ragUrl: config.ragUrl ?? "http://chroma:8000",
      doctrineDir: config.doctrineDir ?? "/doctrine",
      rightsEnabled: config.rightsEnabled ?? true,
      adminGroups: config.adminGroups ?? [],
      rights: config.rights ?? null,
    });
  });

  // POST /api/bot/settings — update settings (admin only). Accepts any subset
  // of the fields; only provided fields are changed, then applied live to every
  // running bot (no restart). Mutations are persisted to the config file.
  router.post("/settings", requireAdmin, (req, res) => {
    const body = req.body ?? {};
    const touched = { idle: false, llm: false, rights: false, roast: false };

    if ("idleTimeoutMinutes" in body) {
      const v = body.idleTimeoutMinutes;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        res.status(400).json({ error: "idleTimeoutMinutes must be a non-negative number", code: "VALIDATION_ERROR" });
        return;
      }
      config.idleTimeoutMinutes = v;
      touched.idle = true;
    }

    if ("llmEnabled" in body) {
      if (typeof body.llmEnabled !== "boolean") {
        res.status(400).json({ error: "llmEnabled must be a boolean", code: "VALIDATION_ERROR" });
        return;
      }
      config.llmEnabled = body.llmEnabled;
      touched.llm = true;
    }
    if ("llmUrl" in body) {
      if (typeof body.llmUrl !== "string") {
        res.status(400).json({ error: "llmUrl must be a string" });
        return;
      }
      config.llmUrl = body.llmUrl.trim();
      touched.llm = true;
    }
    if ("llmModel" in body) {
      if (typeof body.llmModel !== "string") {
        res.status(400).json({ error: "llmModel must be a string" });
        return;
      }
      config.llmModel = body.llmModel.trim();
      touched.llm = true;
    }
    if ("llmSystemPrompt" in body) {
      if (typeof body.llmSystemPrompt !== "string") {
        res.status(400).json({ error: "llmSystemPrompt must be a string" });
        return;
      }
      config.llmSystemPrompt = body.llmSystemPrompt;
      touched.llm = true;
    }
    if ("llmTemperature" in body) {
      const v = body.llmTemperature;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 2) {
        res.status(400).json({ error: "llmTemperature must be a number between 0 and 2", code: "VALIDATION_ERROR" });
        return;
      }
      config.llmTemperature = v;
      touched.llm = true;
    }

    if ("roastEnabled" in body) {
      if (typeof body.roastEnabled !== "boolean") {
        res.status(400).json({ error: "roastEnabled must be a boolean", code: "VALIDATION_ERROR" });
        return;
      }
      config.roastEnabled = body.roastEnabled;
      touched.roast = true;
    }
    if ("roastMinPresent" in body) {
      const v = body.roastMinPresent;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
        res.status(400).json({ error: "roastMinPresent must be an integer >= 1", code: "VALIDATION_ERROR" });
        return;
      }
      config.roastMinPresent = v;
      touched.roast = true;
    }
    if ("roastCooldownMinutes" in body) {
      const v = body.roastCooldownMinutes;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        res.status(400).json({ error: "roastCooldownMinutes must be a non-negative number", code: "VALIDATION_ERROR" });
        return;
      }
      config.roastCooldownMinutes = v;
      touched.roast = true;
    }

    if ("rightsEnabled" in body) {
      if (typeof body.rightsEnabled !== "boolean") {
        res.status(400).json({ error: "rightsEnabled must be a boolean" });
        return;
      }
      config.rightsEnabled = body.rightsEnabled;
      touched.rights = true;
    }
    if ("adminGroups" in body) {
      const v = body.adminGroups;
      if (!Array.isArray(v) || !v.every((n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0)) {
        res.status(400).json({ error: "adminGroups must be an array of non-negative integers" });
        return;
      }
      config.adminGroups = v;
      touched.rights = true;
    }
    if ("rights" in body) {
      const v = body.rights;
      if (v !== null && (typeof v !== "object" || Array.isArray(v))) {
        res.status(400).json({ error: "rights must be an object or null" });
        return;
      }
      config.rights = (v as RightsConfig | null) ?? undefined;
      touched.rights = true;
    }

    saveConfig(configPath, config);

    // Apply live to every bot. Only re-apply the subsystems that changed so an
    // idle-timeout tweak doesn't needlessly rebuild the LLM (dropping history).
    for (const bot of botManager.getAllBots()) {
      if (touched.idle) bot.updateIdleTimeout(config.idleTimeoutMinutes ?? 0);
      if (touched.llm) bot.updateLlm(config.llmEnabled ?? false, config.llmUrl, config.llmModel, config.llmSystemPrompt, config.llmTemperature);
      if (touched.rights) bot.updateRights(config.rightsEnabled ?? true, config.rights);
      if (touched.roast) bot.updateRoast(config.roastEnabled ?? false, config.roastMinPresent, config.roastCooldownMinutes);

    // RAG (Phase 5/6)
    if ("ragEnabled" in body) {
      if (typeof body.ragEnabled !== "boolean") {
        res.status(400).json({ error: "ragEnabled must be a boolean", code: "VALIDATION_ERROR" });
        return;
      }
      config.ragEnabled = body.ragEnabled;
      touched.rag = true; // add if needed
    }
    if ("ragUrl" in body && typeof body.ragUrl === "string") {
      config.ragUrl = body.ragUrl;
    }
    if ("doctrineDir" in body && typeof body.doctrineDir === "string") {
      config.doctrineDir = body.doctrineDir;
    }

    res.json({ ok: true });
  });

  // Phase 6 polish: upload doctrine markdown (saves to doctrineDir + reindexes). Supports frontmatter classification.
  // Also list current doctrine files.
  router.post("/:botId/upload-doctrine", requireAdmin, async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { filename, content } = req.body || {};
      if (!filename || typeof content !== "string" || content.length < 20) {
        return res.status(400).json({ error: "filename and non-trivial content required", code: "VALIDATION_ERROR" });
      }
      const dir = bot.getConfig().doctrineDir || "/doctrine";
      await fs.mkdir(dir, { recursive: true });
      const safe = filename.replace(/[^a-z0-9_.-]/gi, "_") .replace(/\.md$/, "") + ".md";
      await fs.writeFile(path.join(dir, safe), content);
      const ingest = await bot.reindexDoctrine();
      res.json({ ok: true, uploaded: safe, reindexedChunks: ingest.chunks });
    } catch (err) {
      logger.error({ err }, "upload-doctrine failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/:botId/doctrine", requireAuth, async (req, res) => {
    try {
      const bot = (req as any).bot;
      const dir = bot.getConfig().doctrineDir || "/doctrine";
      const files = await fs.readdir(dir).catch(() => []);
      res.json({ files: files.filter((f: string) => f.endsWith(".md")) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Reindex doctrine (admin)
  router.post("/:botId/reindex", requireAdmin, async (req, res) => {
    try {
      const bot = (req as any).bot;
      const result = await bot.reindexDoctrine();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get doctrine file content for preview (auth)
  router.get("/:botId/doctrine/:filename", requireAuth, async (req, res) => {
    try {
      const bot = (req as any).bot;
      const dir = bot.getConfig().doctrineDir || "/doctrine";
      const safe = (req.params.filename as string).replace(/[^a-z0-9_.-]/gi, "_");
      const full = path.join(dir, safe);
      const content = await fs.readFile(full, "utf8");
      res.json({ filename: safe, content });
    } catch (err) {
      res.status(404).json({ error: "Doctrine file not found" });
    }
  });

  // Delete doctrine file (admin)
  router.delete("/:botId/doctrine/:filename", requireAdmin, async (req, res) => {
    try {
      const bot = (req as any).bot;
      const dir = bot.getConfig().doctrineDir || "/doctrine";
      const safe = (req.params.filename as string).replace(/[^a-z0-9_.-]/gi, "_");
      const full = path.join(dir, safe);
      await fs.unlink(full);
      const result = await bot.reindexDoctrine();
      res.json({ ok: true, deleted: safe, ...result });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/bot/llm/status — LLM configured + reachable (for the web panel).
  router.get("/llm/status", async (_req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.json({ configured: config.llmEnabled ?? false, available: false });
      return;
    }
    res.json(await bot.getLlmStatus());
  });

  // POST /api/bot/llm/ask — one-shot Q&A test box (admin only).
  router.post("/llm/ask", requireAdmin, async (req, res) => {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question) {
      res.status(400).json({ error: "question is required" });
      return;
    }
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({ error: "No bot instance available" });
      return;
    }
    const answer = await bot.askLlm(question);
    if (answer === null) {
      res.status(409).json({ error: "LLM is not enabled" });
      return;
    }
    res.json({ answer });
  });

  // Grok Build audit rec #2: effective permissions debug view (per-bot via query or first).
  // Supports ?uid=... to simulate a specific TS UID (resolve happens inside the bot instance).
  // Admin only. Returns the resolved subject + sorted list of allowed commands under current config.
  router.get("/rights/debug", requireAdmin, async (req, res) => {
    const botId = (req.query.botId as string) || undefined;
    const testUid = (req.query.uid as string) || undefined;
    let bot = botId ? botManager.getBot(botId) : botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({ error: "No bot instance available for rights debug" });
      return;
    }
    try {
      const eff = await bot.getEffectiveRights(testUid);
      res.json({
        ...eff,
        botId: bot.id,
        rightsEnabled: bot.getConfig?.().rightsEnabled ?? true,
        note: "Grok Build: computeAllowed via RightsEngine (chat context). Use ?uid=TSUID or ?botId=... for per-bot simulation. Subject groups come from live TS query or low-priv fallback.",
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || "rights debug failed" });
    }
  });

  router.get("/", (_req, res) => {
    const bots = botManager.getAllBots().map((b) => b.getStatus());
    res.json({ bots });
  });

  router.get("/:id", (req, res) => {
    const bot = botManager.getBot(req.params.id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    res.json(bot.getStatus());
  });

  // Get saved config for a bot (contains TS passwords/keys — admin only)
  router.get("/:id/config", requireAdmin, (req, res) => {
    const id = req.params.id as string;
    const saved = botManager.getBotConfig(id);
    if (!saved) {
      res.status(404).json({ error: "Bot config not found" });
      return;
    }
    res.json(saved);
  });

  router.get("/:id/avatar", (req, res) => {
    const id = req.params.id as string;
    const path = botDb.getCustomAvatarPath(id);
    if (!path) {
      res.status(404).end();
      return;
    }
    const buf = avatarStore.read(path);
    if (!buf) {
      res.status(404).end();
      return;
    }
    const ext = path.split(".").pop() ?? "";
    const mime = ext === "png"
      ? "image/png"
      : ext === "webp"
        ? "image/webp"
        : "image/jpeg";
    res.set("Content-Type", mime);
    res.set("Cache-Control", "no-cache");
    res.send(buf);
  });

  router.put("/:id/avatar", requireAdmin, (req, res) => {
    const id = req.params.id as string;
    const exists =
      botManager.getBot(id) ||
      botDb.getBotInstances().some((b) => b.id === id);
    if (!exists) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    const { dataUrl } = req.body as { dataUrl?: string };
    if (typeof dataUrl !== "string") {
      res.status(400).json({ error: "dataUrl required" });
      return;
    }
    const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(dataUrl);
    if (!m) {
      res.status(400).json({ error: "dataUrl must be image/png|jpeg|webp base64" });
      return;
    }
    const mime = m[1] as string;
    const buf = Buffer.from(m[2] ?? "", "base64");
    if (buf.length === 0) {
      res.status(400).json({ error: "empty image" });
      return;
    }
    if (buf.length > 1024 * 1024) {
      res.status(413).json({ error: "avatar exceeds 1MB limit" });
      return;
    }
    const rel = avatarStore.write(id, mime, buf);
    botDb.setCustomAvatarPath(id, rel);
    botManager.getBot(id)?.getProfileManager().setCustomAvatar(buf);
    res.json({ path: rel });
  });

  router.delete("/:id/avatar", requireAdmin, (req, res) => {
    const id = req.params.id as string;
    const path = botDb.getCustomAvatarPath(id);
    if (path) avatarStore.remove(path);
    botDb.setCustomAvatarPath(id, null);
    botManager.getBot(id)?.getProfileManager().setCustomAvatar(null);
    res.status(204).end();
  });

  router.post("/", requireAdmin, async (req, res) => {
    try {
      const {
        name,
        serverAddress,
        serverPort,
        nickname,
        defaultChannel,
        channelPassword,
        serverPassword,
        autoStart,
      } = req.body;
      if (!name || !serverAddress || !nickname) {
        res
          .status(400)
          .json({ error: "name, serverAddress, and nickname are required" });
        return;
      }
      const bot = await botManager.createBot({
        name,
        serverAddress,
        serverPort: serverPort ?? 9987,
        nickname,
        defaultChannel,
        channelPassword,
        channelPassword,
        serverPassword,
        autoStart: autoStart ?? false,
      });
      res.status(201).json(bot.getStatus());
    } catch (err) {
      logger.error({ err }, "Failed to create bot");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
    }
  });

  // Update bot config (must be stopped first to apply connection changes)
  router.put("/:id", requireAdmin, async (req, res) => {
    try {
      const id = req.params.id as string;
      const bot = botManager.getBot(id);
      if (!bot) {
        res.status(404).json({ error: "Bot not found" });
        return;
      }
      const { name, serverAddress, serverPort, nickname, defaultChannel, channelPassword, serverPassword } = req.body;
      // Update in database
      botManager.updateBot(id, {
        name, serverAddress, serverPort, nickname, defaultChannel, channelPassword, serverPassword,
      });
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "Failed to update bot");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
    }
  });

  router.delete("/:id", requireAdmin, async (req, res) => {
    try {
      const id = req.params.id as string;
      await botManager.removeBot(id);
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "Bot management error");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
    }
  });

  router.post("/:id/start", requireAdmin, async (req, res) => {
    try {
      const id = req.params.id as string;
      await botManager.startBot(id);
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "Bot management error");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
    }
  });

  router.post("/:id/stop", requireAdmin, (req, res) => {
    try {
      const id = req.params.id as string;
      botManager.stopBot(id);
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "Bot management error");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
    }
  });

  return router;
}
