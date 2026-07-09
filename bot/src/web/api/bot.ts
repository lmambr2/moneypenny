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
import { defaultRadioConfig, type RadioConfig } from "../../radio/index.js";
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
      kgEnabled: config.kgEnabled ?? false,
      mempalaceEnabled: config.mempalaceEnabled ?? false,
      mempalaceUrl: config.mempalaceUrl ?? "",
      aceStepEnabled: config.aceStepEnabled ?? false,
      aceStepUrl: config.aceStepUrl ?? "",
      aceStepAutoFill: config.aceStepAutoFill ?? false,
      aceStepTimeoutMs: config.aceStepTimeoutMs ?? 300_000,
      aceStepOutputDir: config.aceStepOutputDir ?? "generated/ace-step",
      fileDropEnabled: config.fileDropEnabled ?? false,
      fileDropPollSec: config.fileDropPollSec ?? 30,
      rightsEnabled: config.rightsEnabled ?? true,
      adminGroups: config.adminGroups ?? [],
      rights: config.rights ?? null,
      streamBridgeUrl: config.streamBridgeUrl ?? "",
      pokeCommandsEnabled: config.pokeCommandsEnabled !== false,
      pokeCommandsPerMinute: config.pokeCommandsPerMinute ?? 12,
      voice: { ...defaultVoiceConfig(), ...config.voice },
      radio: { ...defaultRadioConfig(), ...config.radio },
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
      kg: false,
      mempalace: false,
      aceStep: false,
      fileDrop: false,
      stream: false,
      voice: false,
    };

    // Flat config keys, table-driven: {type, bounds, subsystem to re-apply}.
    // Bespoke object blocks (adminGroups/rights/voice/radio) follow below.
    type Touched = keyof typeof touched;
    const FLAT_SETTINGS: {
      key: string;
      type: "boolean" | "string" | "number" | "int";
      min?: number;
      max?: number;
      touch?: Touched;
      msg?: string;
    }[] = [
      { key: "idleTimeoutMinutes", type: "number", min: 0, touch: "idle" },
      { key: "llmEnabled", type: "boolean", touch: "llm" },
      { key: "llmUrl", type: "string", touch: "llm" },
      { key: "llmModel", type: "string", touch: "llm" },
      { key: "llmFallbackUrl", type: "string", touch: "llm" },
      { key: "llmFallbackModel", type: "string", touch: "llm" },
      { key: "llmDelegateUrl", type: "string", touch: "llm" },
      { key: "llmDelegateModel", type: "string", touch: "llm" },
      { key: "llmSystemPrompt", type: "string", touch: "llm" },
      { key: "llmTemperature", type: "number", min: 0, max: 2, touch: "llm", msg: "llmTemperature must be a number between 0 and 2" },
      { key: "roastEnabled", type: "boolean", touch: "roast" },
      { key: "roastMinPresent", type: "int", min: 1, touch: "roast" },
      { key: "roastCooldownMinutes", type: "number", min: 0, touch: "roast" },
      { key: "roastMinScore", type: "int", min: 0, max: 10, touch: "roast", msg: "roastMinScore must be an integer 0\u201310" },
      // youtubeSaveEnabled is read live from the shared config — no re-apply.
      { key: "youtubeSaveEnabled", type: "boolean" },
      { key: "ragEnabled", type: "boolean", touch: "rag" },
      { key: "ragTopK", type: "int", min: 1, touch: "rag" },
      { key: "vectorDbUrl", type: "string" },
      { key: "embeddingUrl", type: "string" },
      { key: "embeddingModel", type: "string" },
      { key: "ragCollection", type: "string" },
      { key: "memoryEnabled", type: "boolean", touch: "memory" },
      { key: "kgEnabled", type: "boolean", touch: "kg" },
      { key: "mempalaceEnabled", type: "boolean", touch: "mempalace" },
      { key: "mempalaceUrl", type: "string", touch: "mempalace" },
      { key: "aceStepEnabled", type: "boolean", touch: "aceStep" },
      { key: "aceStepUrl", type: "string", touch: "aceStep" },
      { key: "aceStepAutoFill", type: "boolean", touch: "aceStep" },
      { key: "aceStepTimeoutMs", type: "int", min: 10_000, max: 900_000, touch: "aceStep" },
      { key: "aceStepOutputDir", type: "string", touch: "aceStep" },
      { key: "fileDropEnabled", type: "boolean", touch: "fileDrop" },
      { key: "fileDropPollSec", type: "int", min: 5, touch: "fileDrop" },
      { key: "rightsEnabled", type: "boolean", touch: "rights" },
      { key: "streamBridgeUrl", type: "string", touch: "stream" },
      { key: "pokeCommandsEnabled", type: "boolean" },
      { key: "pokeCommandsPerMinute", type: "int", min: 1, max: 120 },
    ];

    const cfg = config as unknown as Record<string, unknown>;
    for (const spec of FLAT_SETTINGS) {
      if (!(spec.key in body)) continue;
      const v = body[spec.key];
      const fail = (msg: string) => res.status(400).json({ error: msg, code: "VALIDATION_ERROR" });
      if (spec.type === "boolean") {
        if (typeof v !== "boolean") { fail(spec.msg ?? `${spec.key} must be a boolean`); return; }
        cfg[spec.key] = v;
      } else if (spec.type === "string") {
        if (typeof v !== "string") { fail(spec.msg ?? `${spec.key} must be a string`); return; }
        cfg[spec.key] = v.trim();
      } else {
        const isInt = spec.type === "int";
        const ok = typeof v === "number" && Number.isFinite(v) && (!isInt || Number.isInteger(v)) &&
          (spec.min === undefined || v >= spec.min) && (spec.max === undefined || v <= spec.max);
        if (!ok) {
          const bound = spec.min !== undefined && spec.min > 0 ? ` >= ${spec.min}` : "";
          fail(spec.msg ?? (isInt ? `${spec.key} must be an integer${bound}` : `${spec.key} must be a non-negative number`));
          return;
        }
        cfg[spec.key] = v;
      }
      if (spec.touch) touched[spec.touch] = true;
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
      if ("duckMusicVolume" in patch) {
        const v = patch.duckMusicVolume;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
          res.status(400).json({
            error: "voice.duckMusicVolume must be a number 0–100",
            code: "VALIDATION_ERROR",
          });
          return;
        }
      }
      if ("listenWindowMs" in patch) {
        const v = patch.listenWindowMs;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 5000 || v > 60_000) {
          res.status(400).json({
            error: "voice.listenWindowMs must be 5000–60000",
            code: "VALIDATION_ERROR",
          });
          return;
        }
      }
      if ("energyThreshold" in patch && typeof patch.energyThreshold !== "number") {
        res.status(400).json({ error: "voice.energyThreshold must be a number", code: "VALIDATION_ERROR" });
        return;
      }
      config.voice = { ...defaultVoiceConfig(), ...config.voice, ...patch };
      touched.voice = true;
    }

    if ("radio" in body) {
      const r = body.radio;
      if (typeof r !== "object" || r === null || Array.isArray(r)) {
        res.status(400).json({ error: "radio must be an object", code: "VALIDATION_ERROR" });
        return;
      }
      const patch = r as Partial<RadioConfig>;
      for (const key of ["enabled", "memoryBroadcastOptIn"] as const) {
        if (key in patch && typeof patch[key] !== "boolean") {
          res.status(400).json({ error: `radio.${key} must be a boolean`, code: "VALIDATION_ERROR" });
          return;
        }
      }
      for (const key of [
        "everyNSongs", "deadAirSeconds", "maxBumperSeconds", "speechVolumePct",
        "minPresentToBroadcast", "cooldownSeconds", "maxBumpersPerHour",
      ] as const) {
        const v = patch[key];
        if (key in patch && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
          res.status(400).json({ error: `radio.${key} must be a non-negative number`, code: "VALIDATION_ERROR" });
          return;
        }
      }
      if ("sources" in patch) {
        const valid = new Set(["prerecorded", "stationId", "timeCheck", "nowPlaying", "doctrine", "memory"]);
        if (!Array.isArray(patch.sources) || !patch.sources.every((s) => typeof s === "string" && valid.has(s))) {
          res.status(400).json({ error: "radio.sources must be an array of known source names", code: "VALIDATION_ERROR" });
          return;
        }
      }
      if ("quietHours" in patch) {
        const ok = Array.isArray(patch.quietHours) &&
          patch.quietHours.every((w) => w && typeof w.from === "string" && typeof w.to === "string");
        if (!ok) {
          res.status(400).json({ error: "radio.quietHours must be [{from,to}] of HH:MM strings", code: "VALIDATION_ERROR" });
          return;
        }
      }
      for (const key of ["activeProfile", "ttsVoice", "bumperDir"] as const) {
        if (key in patch && typeof patch[key] !== "string") {
          res.status(400).json({ error: `radio.${key} must be a string`, code: "VALIDATION_ERROR" });
          return;
        }
      }
      if ("profiles" in patch) {
        const p = patch.profiles;
        const ok = typeof p === "object" && p !== null && !Array.isArray(p) &&
          Object.values(p).every((prof) => typeof prof === "object" && prof !== null && !Array.isArray(prof));
        if (!ok) {
          res.status(400).json({ error: "radio.profiles must be an object of profile objects", code: "VALIDATION_ERROR" });
          return;
        }
      }
      if ("clock" in patch) {
        const c = patch.clock;
        const ok = typeof c === "object" && c !== null && Array.isArray((c as { wheel?: unknown }).wheel) &&
          ((c as { wheel: unknown[] }).wheel).every(
            (s) => s !== null && typeof s === "object" && typeof (s as { slot?: unknown }).slot === "string",
          );
        if (!ok) {
          res.status(400).json({ error: "radio.clock must have a wheel of {slot} entries", code: "VALIDATION_ERROR" });
          return;
        }
      }
      if ("classificationFloor" in patch) {
        const f = patch.classificationFloor;
        if (!Array.isArray(f) || !f.every((x) => typeof x === "string")) {
          res.status(400).json({ error: "radio.classificationFloor must be an array of strings", code: "VALIDATION_ERROR" });
          return;
        }
        // §6.3: this overrides the presence-based broadcast floor — loud trail.
        logger.warn({ floor: f }, "radio.classificationFloor override set via settings");
      }
      // S1: only known RadioConfig keys pass — an unexpected key is rejected,
      // not silently spread into config.
      const KNOWN_RADIO_KEYS = new Set([
        "enabled", "everyNSongs", "deadAirSeconds", "maxBumperSeconds", "speechVolumePct",
        "minPresentToBroadcast", "cooldownSeconds", "maxBumpersPerHour",
        "quietHours", "sources", "memoryBroadcastOptIn", "classificationFloor",
        "activeProfile", "profiles", "clock", "ttsVoice", "bumperDir",
        "analyzer", "ratingWeight", "harmonicSequencing", "icecast",
      ]);
      const unknown = Object.keys(patch).filter((k) => !KNOWN_RADIO_KEYS.has(k));
      if (unknown.length > 0) {
        res.status(400).json({ error: `unknown radio settings: ${unknown.join(", ")}`, code: "VALIDATION_ERROR" });
        return;
      }
      // The director reads config.radio live at every boundary, so replacing
      // the block hot-applies with no per-bot re-init (unlike voice/llm).
      config.radio = { ...defaultRadioConfig(), ...config.radio, ...patch };
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
      if (touched.roast) {
        bot.updateRoast(
          config.roastEnabled ?? false,
          config.roastMinPresent,
          config.roastCooldownMinutes,
          config.roastMinScore,
        );
      }
      if (touched.rag) bot.updateRag(config.ragEnabled ?? false, config.ragTopK);
      if (touched.fileDrop) bot.updateFileDrop(config.fileDropEnabled ?? false, config.fileDropPollSec);
      if (touched.memory) bot.updateMemory(config.memoryEnabled ?? false);
      if (touched.kg) bot.updateKg(config.kgEnabled ?? false);
      if (touched.mempalace) {
        bot.updateMemPalace(config.mempalaceEnabled ?? false, config.mempalaceUrl);
      }
      if (touched.aceStep) {
        bot.updateAceStep({
          enabled: config.aceStepEnabled ?? false,
          url: config.aceStepUrl,
          autoFill: config.aceStepAutoFill,
          timeoutMs: config.aceStepTimeoutMs,
          outputDir: config.aceStepOutputDir,
        });
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
        ttsVoice: config.voice?.ttsVoice ?? "en_GB-southern_english_female-low",
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
      const userMemory = await bot.syncMemoryToMemPalace();
      const kg = await bot.syncKgToMemPalace();
      res.json({ ok: true, userMemory, kg });
    } catch (err: unknown) {
      res.status(502).json({ error: errorMessage(err, "memory sync failed"), code: "MEMORY_ERROR" });
    }
  });

  // GET /api/bot/ace-step/status — ACE-Step sidecar configured + reachable.
  router.get("/ace-step/status", requireAdmin, async (_req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.json({
        configured: !!(config.aceStepEnabled && config.aceStepUrl?.trim()),
        available: false,
        url: config.aceStepUrl ?? "",
        autoFill: config.aceStepAutoFill ?? false,
      });
      return;
    }
    res.json(await bot.getAceStepStatus());
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

  // GET /api/bot/radio/status — live director state (admin).
  router.get("/radio/status", requireAdmin, async (_req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.json({ enabled: config.radio?.enabled ?? false, connected: false });
      return;
    }
    res.json({ connected: true, ...bot.getRadioStatus() });
  });

  // POST /api/bot/radio/test-bumper — cue a bumper now (admin; needs radio on + TTS/voice).
  router.post("/radio/test-bumper", requireAdmin, async (req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({ error: "No bot instance available", code: "NO_BOT" });
      return;
    }
    if (!(config.radio?.enabled ?? false)) {
      res.status(409).json({ error: "Radio mode is off — enable it in Settings first", code: "RADIO_OFF" });
      return;
    }
    const topic = typeof req.body?.topic === "string" ? req.body.topic.trim() : undefined;
    try {
      const result = await bot.cueRadioBumper(topic || undefined);
      res.json({ ok: true, result });
    } catch (err: unknown) {
      res.status(502).json({ error: errorMessage(err, "bumper cue failed"), code: "RADIO_ERROR" });
    }
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
