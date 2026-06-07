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

  // ─── Global settings ──────────────────────────────────────────────────────
  // NOTE: these MUST be registered before "/:id" — otherwise GET /settings is
  // captured by the "/:id" param route (id="settings") and never reaches here.

  // GET /api/bot/settings — read global bot behavior + AI/permission settings.
  router.get("/settings", (_req, res) => {
    res.json({
      idleTimeoutMinutes: config.idleTimeoutMinutes ?? 0,
      llmEnabled: config.llmEnabled ?? false,
      llmUrl: config.llmUrl ?? "",
      llmModel: config.llmModel ?? "",
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
    const touched = { idle: false, llm: false, rights: false };

    if ("idleTimeoutMinutes" in body) {
      const v = body.idleTimeoutMinutes;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        res.status(400).json({ error: "idleTimeoutMinutes must be a non-negative number" });
        return;
      }
      config.idleTimeoutMinutes = v;
      touched.idle = true;
    }

    if ("llmEnabled" in body) {
      if (typeof body.llmEnabled !== "boolean") {
        res.status(400).json({ error: "llmEnabled must be a boolean" });
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
      if (touched.llm) bot.updateLlm(config.llmEnabled ?? false, config.llmUrl, config.llmModel);
      if (touched.rights) bot.updateRights(config.rightsEnabled ?? true, config.rights);
    }

    res.json({ ok: true });
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

  // Get saved config for a bot
  router.get("/:id/config", (req, res) => {
    const saved = botManager.getBotConfig(req.params.id);
    if (!saved) {
      res.status(404).json({ error: "Bot config not found" });
      return;
    }
    res.json(saved);
  });

  router.get("/:id/avatar", (req, res) => {
    const path = botDb.getCustomAvatarPath(req.params.id);
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
    const exists =
      botManager.getBot(req.params.id) ||
      botDb.getBotInstances().some((b) => b.id === req.params.id);
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
    if (buf.length > 200 * 1024) {
      res.status(413).json({ error: "avatar exceeds 200KB limit" });
      return;
    }
    const rel = avatarStore.write(req.params.id, mime, buf);
    botDb.setCustomAvatarPath(req.params.id, rel);
    botManager.getBot(req.params.id)?.getProfileManager().setCustomAvatar(buf);
    res.json({ path: rel });
  });

  router.delete("/:id/avatar", requireAdmin, (req, res) => {
    const path = botDb.getCustomAvatarPath(req.params.id);
    if (path) avatarStore.remove(path);
    botDb.setCustomAvatarPath(req.params.id, null);
    botManager.getBot(req.params.id)?.getProfileManager().setCustomAvatar(null);
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
        serverPassword,
        autoStart: autoStart ?? false,
      });
      res.status(201).json(bot.getStatus());
    } catch (err) {
      logger.error({ err }, "Failed to create bot");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Update bot config (must be stopped first to apply connection changes)
  router.put("/:id", requireAdmin, async (req, res) => {
    try {
      const bot = botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: "Bot not found" });
        return;
      }
      const { name, serverAddress, serverPort, nickname, defaultChannel, channelPassword, serverPassword } = req.body;
      // Update in database
      botManager.updateBot(req.params.id, {
        name, serverAddress, serverPort, nickname, defaultChannel, channelPassword, serverPassword,
      });
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "Failed to update bot");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete("/:id", requireAdmin, async (req, res) => {
    try {
      await botManager.removeBot(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:id/start", requireAdmin, async (req, res) => {
    try {
      await botManager.startBot(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:id/stop", requireAdmin, (req, res) => {
    try {
      botManager.stopBot(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
