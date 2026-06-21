import { Router } from "express";
import axios from "axios";
import type { BotManager } from "../../bot/manager.js";
import type { BotConfig } from "../../data/config.js";
import { redactBotInstanceSecrets } from "../../data/bot-secrets.js";
import { saveConfig } from "../../data/config.js";
import type { Logger } from "../../logger.js";
import type { BotDatabase } from "../../data/database.js";
import type { AvatarStore } from "../../data/avatars.js";
import { isRightsConfig, type RightsConfig } from "../../rights/index.js";
import { defaultVoiceConfig, type VoiceConfig } from "../../voice/types.js";
import { errorMessage } from "../../util/error.js";
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

  // GET /api/bot/settings — read global bot behavior + AI/permission settings (admin only).
  router.get("/settings", requireAdmin, (_req, res) => {
    res.json({
      idleTimeoutMinutes: config.idleTimeoutMinutes ?? 0,
      llmEnabled: config.llmEnabled ?? false,
      llmUrl: config.llmUrl ?? "",
      llmModel: config.llmModel ?? "",
      llmFallbackUrl: config.llmFallbackUrl ?? "",
      llmFallbackModel: config.llmFallbackModel ?? "",
      llmDelegateUrl: config.llmDelegateUrl ?? "",
      llmDelegateModel: config.llmDelegateModel ?? "",
      llmSystemPrompt: config.llmSystemPrompt ?? "",
      llmTemperature: config.llmTemperature ?? 0.2,
      roastEnabled: config.roastEnabled ?? false,
      roastMinPresent: config.roastMinPresent ?? 3,
      roastCooldownMinutes: config.roastCooldownMinutes ?? 180,
      roastMinScore: config.roastMinScore ?? 4,
      youtubeSaveEnabled: config.youtubeSaveEnabled ?? false,
      ragEnabled: config.ragEnabled ?? false,
      ragTopK: config.ragTopK ?? 4,
      memoryEnabled: config.memoryEnabled ?? false,
      mempalaceEnabled: config.mempalaceEnabled ?? false,
      mempalaceUrl: config.mempalaceUrl ?? "",
      fileDropEnabled: config.fileDropEnabled ?? false,
      fileDropPollSec: config.fileDropPollSec ?? 30,
      rightsEnabled: config.rightsEnabled ?? true,
      adminGroups: config.adminGroups ?? [],
      rights: config.rights ?? null,
      streamBridgeUrl: config.streamBridgeUrl ?? "",
      voice: { ...defaultVoiceConfig(), ...config.voice },
      vectorDbUrl: config.vectorDbUrl ?? "",
      embeddingUrl: config.embeddingUrl ?? "",
      embeddingModel: config.embeddingModel ?? "",
      ragCollection: config.ragCollection ?? "moneypenny_docs",
    });
  });

  // POST /api/bot/settings — update settings (admin only). Accepts any subset
  // of the fields; only provided fields are changed, then applied live to every
  // running bot (no restart). Mutations are persisted to the config file.
  router.post("/settings", requireAdmin, (req, res) => {
    const body = req.body ?? {};
    const touched = {
      idle: false,
      llm: false,
      rights: false,
      roast: false,
      rag: false,
      memory: false,
      mempalace: false,
      fileDrop: false,
      stream: false,
      voice: false,
    };

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
    if ("llmFallbackUrl" in body) {
      if (typeof body.llmFallbackUrl !== "string") {
        res.status(400).json({ error: "llmFallbackUrl must be a string", code: "VALIDATION_ERROR" });
        return;
      }
      config.llmFallbackUrl = body.llmFallbackUrl.trim();
      touched.llm = true;
    }
    if ("llmFallbackModel" in body) {
      if (typeof body.llmFallbackModel !== "string") {
        res.status(400).json({ error: "llmFallbackModel must be a string", code: "VALIDATION_ERROR" });
        return;
      }
      config.llmFallbackModel = body.llmFallbackModel.trim();
      touched.llm = true;
    }
    if ("llmDelegateUrl" in body) {
      if (typeof body.llmDelegateUrl !== "string") {
        res.status(400).json({ error: "llmDelegateUrl must be a string", code: "VALIDATION_ERROR" });
        return;
      }
      config.llmDelegateUrl = body.llmDelegateUrl.trim();
      touched.llm = true;
    }
    if ("llmDelegateModel" in body) {
      if (typeof body.llmDelegateModel !== "string") {
        res.status(400).json({ error: "llmDelegateModel must be a string", code: "VALIDATION_ERROR" });
        return;
      }
      config.llmDelegateModel = body.llmDelegateModel.trim();
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
    if ("roastMinScore" in body) {
      const v = body.roastMinScore;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10) {
        res.status(400).json({ error: "roastMinScore must be an integer 0–10", code: "VALIDATION_ERROR" });
        return;
      }
      config.roastMinScore = v;
      touched.roast = true;
    }
    if ("youtubeSaveEnabled" in body) {
      if (typeof body.youtubeSaveEnabled !== "boolean") {
        res.status(400).json({ error: "youtubeSaveEnabled must be a boolean", code: "VALIDATION_ERROR" });
        return;
      }
      // Read live from the shared config in resolveAndPlay — no per-bot apply needed.
      config.youtubeSaveEnabled = body.youtubeSaveEnabled;
    }

    if ("ragEnabled" in body) {
      if (typeof body.ragEnabled !== "boolean") {
        res.status(400).json({ error: "ragEnabled must be a boolean", code: "VALIDATION_ERROR" });
        return;
      }
      config.ragEnabled = body.ragEnabled;
      touched.rag = true;
    }
    if ("ragTopK" in body) {
      const v = body.ragTopK;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
        res.status(400).json({ error: "ragTopK must be an integer >= 1", code: "VALIDATION_ERROR" });
        return;
      }
      config.ragTopK = v;
      touched.rag = true;
    }
    for (const [key, label] of [
      ["vectorDbUrl", "vectorDbUrl"],
      ["embeddingUrl", "embeddingUrl"],
      ["embeddingModel", "embeddingModel"],
      ["ragCollection", "ragCollection"],
    ] as const) {
      if (key in body) {
        if (typeof body[key] !== "string") {
          res.status(400).json({ error: `${label} must be a string`, code: "VALIDATION_ERROR" });
          return;
        }
        config[key] = body[key].trim();
      }
    }
    if ("memoryEnabled" in body) {
      if (typeof body.memoryEnabled !== "boolean") {
        res.status(400).json({ error: "memoryEnabled must be a boolean", code: "VALIDATION_ERROR" });
        return;
      }
      config.memoryEnabled = body.memoryEnabled;
      touched.memory = true;
    }
    if ("mempalaceEnabled" in body) {
      if (typeof body.mempalaceEnabled !== "boolean") {
        res.status(400).json({ error: "mempalaceEnabled must be a boolean", code: "VALIDATION_ERROR" });
        return;
      }
      config.mempalaceEnabled = body.mempalaceEnabled;
      touched.mempalace = true;
    }
    if ("mempalaceUrl" in body) {
      if (typeof body.mempalaceUrl !== "string") {
        res.status(400).json({ error: "mempalaceUrl must be a string", code: "VALIDATION_ERROR" });
        return;
      }
      config.mempalaceUrl = body.mempalaceUrl.trim();
      touched.mempalace = true;
    }

    if ("fileDropEnabled" in body) {
      if (typeof body.fileDropEnabled !== "boolean") {
        res.status(400).json({ error: "fileDropEnabled must be a boolean", code: "VALIDATION_ERROR" });
        return;
      }
      config.fileDropEnabled = body.fileDropEnabled;
      touched.fileDrop = true;
    }
    if ("fileDropPollSec" in body) {
      const v = body.fileDropPollSec;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 5) {
        res.status(400).json({ error: "fileDropPollSec must be an integer >= 5", code: "VALIDATION_ERROR" });
        return;
      }
      config.fileDropPollSec = v;
      touched.fileDrop = true;
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
      if (v === null) {
        config.rights = undefined;
        touched.rights = true;
      } else if (!isRightsConfig(v)) {
        res.status(400).json({ error: "rights must be a valid RightsConfig object or null", code: "VALIDATION_ERROR" });
        return;
      } else {
        config.rights = v;
        touched.rights = true;
      }
    }

    if ("streamBridgeUrl" in body) {
      if (typeof body.streamBridgeUrl !== "string") {
        res.status(400).json({ error: "streamBridgeUrl must be a string", code: "VALIDATION_ERROR" });
        return;
      }
      config.streamBridgeUrl = body.streamBridgeUrl.trim();
      touched.stream = true;
    }

    if ("voice" in body) {
      const v = body.voice;
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        res.status(400).json({ error: "voice must be an object", code: "VALIDATION_ERROR" });
        return;
      }
      const patch = v as Partial<VoiceConfig>;
      if ("enabled" in patch && typeof patch.enabled !== "boolean") {
        res.status(400).json({ error: "voice.enabled must be a boolean", code: "VALIDATION_ERROR" });
        return;
      }
      if ("respondWithVoice" in patch && typeof patch.respondWithVoice !== "boolean") {
        res.status(400).json({ error: "voice.respondWithVoice must be a boolean", code: "VALIDATION_ERROR" });
        return;
      }
      for (const key of ["sttUrl", "ttsUrl", "ttsVoice", "watchword"] as const) {
        if (key in patch && typeof patch[key] !== "string") {
          res.status(400).json({ error: `voice.${key} must be a string`, code: "VALIDATION_ERROR" });
          return;
        }
      }
      if ("requireWatchword" in patch && typeof patch.requireWatchword !== "boolean") {
        res.status(400).json({ error: "voice.requireWatchword must be a boolean", code: "VALIDATION_ERROR" });
        return;
      }
      if ("duckMusicOnSpeech" in patch && typeof patch.duckMusicOnSpeech !== "boolean") {
        res.status(400).json({ error: "voice.duckMusicOnSpeech must be a boolean", code: "VALIDATION_ERROR" });
        return;
      }
      if ("energyThreshold" in patch && typeof patch.energyThreshold !== "number") {
        res.status(400).json({ error: "voice.energyThreshold must be a number", code: "VALIDATION_ERROR" });
        return;
      }
      config.voice = { ...defaultVoiceConfig(), ...config.voice, ...patch };
      touched.voice = true;
    }

    saveConfig(configPath, config);

    // Apply live to every bot. Only re-apply the subsystems that changed so an
    // idle-timeout tweak doesn't needlessly rebuild the LLM (dropping history).
    for (const bot of botManager.getAllBots()) {
      if (touched.idle) bot.updateIdleTimeout(config.idleTimeoutMinutes ?? 0);
      if (touched.llm) {
        bot.updateLlm(
          config.llmEnabled ?? false,
          config.llmUrl,
          config.llmModel,
          config.llmSystemPrompt,
          config.llmTemperature,
          config.llmFallbackUrl,
          config.llmFallbackModel,
          config.llmDelegateUrl,
          config.llmDelegateModel,
        );
      }
      if (touched.rights) bot.updateRights(config.rightsEnabled ?? true, config.rights);
      if (touched.roast) bot.updateRoast(config.roastEnabled ?? false, config.roastMinPresent, config.roastCooldownMinutes);
      if (touched.rag) bot.updateRag(config.ragEnabled ?? false, config.ragTopK);
      if (touched.fileDrop) bot.updateFileDrop(config.fileDropEnabled ?? false, config.fileDropPollSec);
      if (touched.memory) bot.updateMemory(config.memoryEnabled ?? false);
      if (touched.mempalace) {
        bot.updateMemPalace(config.mempalaceEnabled ?? false, config.mempalaceUrl);
      }
      if (touched.stream) bot.updateStreamBridge(config.streamBridgeUrl ?? "");
      if (touched.voice && config.voice) bot.updateVoice(config.voice);
    }

    res.json({ ok: true });
  });

  // GET /api/bot/voice/status — STT/TTS sidecar probes + pipeline active flag.
  router.get("/voice/status", requireAdmin, async (_req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.json({
        enabled: config.voice?.enabled ?? false,
        active: false,
        sttUrl: config.voice?.sttUrl ?? "",
        ttsUrl: config.voice?.ttsUrl ?? "",
        ttsVoice: config.voice?.ttsVoice ?? "bf_emma",
        respondWithVoice: config.voice?.respondWithVoice ?? true,
        sttAvailable: false,
        ttsAvailable: false,
      });
      return;
    }
    res.json(await bot.getVoiceStatus());
  });

  // POST /api/bot/voice/test — synthetic transcript through router (no Opus capture).
  router.post("/voice/test", requireAdmin, async (req, res) => {
    const transcript = typeof req.body?.transcript === "string" ? req.body.transcript.trim() : "";
    if (!transcript) {
      res.status(400).json({ error: "transcript is required", code: "VALIDATION_ERROR" });
      return;
    }
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({ error: "No bot instance available", code: "NO_BOT" });
      return;
    }
    try {
      const speak = req.body?.speak === true;
      const result = await bot.testVoiceTurn(transcript, { speak });
      res.json(result);
    } catch (err: unknown) {
      res.status(409).json({ error: errorMessage(err, "voice test failed"), code: "VOICE_UNAVAILABLE" });
    }
  });

  // POST /api/bot/memory/sync — backfill SQLite !remember facts into MemPalace.
  router.post("/memory/sync", requireAdmin, async (_req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({ error: "No bot instance available", code: "NO_BOT" });
      return;
    }
    try {
      const result = await bot.syncMemoryToMemPalace();
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      res.status(502).json({ error: errorMessage(err, "memory sync failed"), code: "MEMORY_ERROR" });
    }
  });

  // GET /api/bot/memory/status — MemPalace sidecar configured + reachable.
  router.get("/memory/status", requireAdmin, async (_req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.json({
        configured: config.mempalaceEnabled ?? false,
        available: false,
        url: config.mempalaceUrl ?? "",
      });
      return;
    }
    res.json(await bot.getMemPalaceStatus());
  });

  // GET /api/bot/rag/status — knowledge-base configured + vector substrate reachable.
  router.get("/rag/status", requireAdmin, async (_req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.json({
        configured: config.ragEnabled ?? false,
        available: false,
        docCount: 0,
        topK: config.ragTopK ?? 4,
        vectorDbUrl: config.vectorDbUrl ?? "",
        embeddingUrl: config.embeddingUrl ?? "",
        embeddingModel: config.embeddingModel ?? "",
        ragCollection: config.ragCollection ?? "moneypenny_docs",
      });
      return;
    }
    res.json(await bot.getRagStatus());
  });

  // POST /api/bot/rag/query — admin test retrieval (no LLM, chunks only).
  router.post("/rag/query", requireAdmin, async (req, res) => {
    const q = typeof req.body?.q === "string" ? req.body.q.trim() : "";
    if (!q) {
      res.status(400).json({ error: "q is required", code: "VALIDATION_ERROR" });
      return;
    }
    const topK = Number.isInteger(req.body?.topK) ? req.body.topK : undefined;
    const allowedClassifications = Array.isArray(req.body?.allowedClassifications)
      ? req.body.allowedClassifications.filter((c: unknown) => typeof c === "string")
      : undefined;

    if (!(config.ragEnabled ?? false)) {
      res.status(409).json({ error: "Knowledge base is disabled in settings", code: "RAG_DISABLED" });
      return;
    }

    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({
        error: "No bot instance — start a bot and ensure RAG was enabled at boot (--profile rag)",
        code: "NO_BOT",
      });
      return;
    }

    try {
      const chunks = await bot.queryRag(q, topK, allowedClassifications);
      if (chunks === null) {
        res.status(409).json({
          error: "RAG substrate not initialized — enable knowledge base and restart with --profile rag",
          code: "RAG_UNAVAILABLE",
        });
        return;
      }
      res.json({ q, chunks });
    } catch (err: unknown) {
      logger.error({ err }, "RAG test query failed");
      res.status(502).json({ error: errorMessage(err, "query failed"), code: "RAG_ERROR" });
    }
  });

  // GET /api/bot/stream-bridge/status — probe the configured bridge /health.
  router.get("/stream-bridge/status", requireAdmin, async (_req, res) => {
    const url = (config.streamBridgeUrl || process.env.STREAM_BRIDGE_URL || "").replace(/\/$/, "");
    if (!url) {
      res.json({ configured: false, available: false, loggedIn: false });
      return;
    }
    try {
      const { data } = await axios.get(`${url}/health`, { timeout: 5000 });
      res.json({
        configured: true,
        available: !!data?.ok,
        loggedIn: !!data?.loggedIn,
      });
    } catch (err) {
      logger.debug({ err, url }, "Stream bridge health check failed");
      res.json({ configured: true, available: false, loggedIn: false });
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

  // GET /api/bot/rights/debug?uid=...&groups=105,106 — effective rights for a subject
  // (admin). Test what a real user (uid) or a hypothetical server-group set can
  // run, in both chat and voice contexts — verifies the ruleset incl. scoping.
  router.get("/rights/debug", requireAdmin, async (req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({ error: "No bot instance available", code: "NO_BOT" });
      return;
    }
    const uid = typeof req.query.uid === "string" ? req.query.uid : undefined;
    const groupsRaw = typeof req.query.groups === "string" ? req.query.groups.trim() : "";
    const serverGroups = groupsRaw ? groupsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    res.json(await bot.getEffectiveRights({ uid, serverGroups }));
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

  // Get saved config for a bot (contains TS passwords/keys — admin only)
  router.get("/:id/config", requireAdmin, (req, res) => {
    const id = req.params.id as string;
    const saved = botManager.getBotConfig(id);
    if (!saved) {
      res.status(404).json({ error: "Bot config not found" });
      return;
    }
    res.json(redactBotInstanceSecrets(saved));
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
