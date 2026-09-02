import { dirname } from "node:path";
import { Router } from "express";
import { clampMusicOpusBitrateKbps } from "../../audio/encoder.js";
import type { BotManager } from "../../bot/manager.js";
import { parseBotScope } from "../../bot/scope.js";
import type { AuditStore } from "../../data/audit.js";
import type { AvatarStore } from "../../data/avatars.js";
import { redactBotInstanceSecrets } from "../../data/bot-secrets.js";
import type { BotConfig } from "../../data/config.js";
import { saveConfig } from "../../data/config.js";
import type { BotDatabase } from "../../data/database.js";
import {
  deleteRecording,
  listRecordings,
  readRecording,
  safeRecordingBasename,
  writeRecording,
} from "../../data/recordings.js";
import type { Logger } from "../../logger.js";
import { defaultRadioConfig, parseAudioColorPreset, type RadioConfig } from "../../radio/index.js";
import { isRightsConfig } from "../../rights/index.js";
import { errorMessage } from "../../util/error.js";
import { fetchJson } from "../../util/http.js";
import { defaultVoiceConfig, type VoiceConfig } from "../../voice/types.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

export function createBotRouter(
  botManager: BotManager,
  config: BotConfig,
  configPath: string,
  logger: Logger,
  botDb: BotDatabase,
  avatarStore: AvatarStore,
  audit?: AuditStore,
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
      musicOpusBitrateKbps: config.musicOpusBitrateKbps ?? 64,
      musicBlockedGenres: Array.isArray(config.musicBlockedGenres)
        ? config.musicBlockedGenres
        : ["rap", "hip hop", "hip-hop", "hiphop", "r&b", "rnb", "r and b", "rhythm and blues"],
      autoFollowEnabled: config.autoFollowEnabled ?? false,
      autoFollowCooldownSec: config.autoFollowCooldownSec ?? 60,
      ragEnabled: config.ragEnabled ?? false,
      ragTopK: config.ragTopK ?? 6,
      memoryEnabled: config.memoryEnabled ?? false,
      kgEnabled: config.kgEnabled ?? false,
      mempalaceEnabled: config.mempalaceEnabled ?? false,
      mempalaceUrl: config.mempalaceUrl ?? "",
      scOrgStatusUrl: config.scOrgStatusUrl ?? "",
      scOrgName: config.scOrgName ?? "",
      aceStepEnabled: config.aceStepEnabled ?? false,
      aceStepUrl: config.aceStepUrl ?? "",
      aceStepAutoFill: config.aceStepAutoFill ?? false,
      aceStepTimeoutMs: config.aceStepTimeoutMs ?? 300_000,
      aceStepOutputDir: config.aceStepOutputDir ?? "generated/ace-step",
      aceStepMaxFiles: config.aceStepMaxFiles ?? 40,
      fileDropEnabled: config.fileDropEnabled ?? false,
      fileDropPollSec: config.fileDropPollSec ?? 30,
      rightsEnabled: config.rightsEnabled ?? true,
      adminGroups: config.adminGroups ?? [],
      rights: config.rights ?? null,
      streamBridgeUrl: config.streamBridgeUrl ?? "",
      pokeCommandsEnabled: config.pokeCommandsEnabled !== false,
      pokeCommandsPerMinute: config.pokeCommandsPerMinute ?? 12,
      trustProxy: config.trustProxy ?? false,
      trustProxyHops: config.trustProxyHops ?? 1,
      scope: config.scope ?? { channelHint: "", serverLabel: "", virtualServerId: "" },
      harnessIntentAllowDangerous: config.harnessIntentAllowDangerous === true,
      recordingsEnabled: config.recordingsEnabled === true,
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
      musicBitrate: false,
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
      { key: "autoFollowEnabled", type: "boolean" },
      // autoFollowAfkChannels is a string[] and has no flat type; edit it in
      // config.json. Its defaults already cover the usual AFK channel names.
      { key: "autoFollowCooldownSec", type: "number", min: 0 },
      { key: "llmEnabled", type: "boolean", touch: "llm" },
      { key: "llmUrl", type: "string", touch: "llm" },
      { key: "llmModel", type: "string", touch: "llm" },
      { key: "llmFallbackUrl", type: "string", touch: "llm" },
      { key: "llmFallbackModel", type: "string", touch: "llm" },
      { key: "llmDelegateUrl", type: "string", touch: "llm" },
      { key: "llmDelegateModel", type: "string", touch: "llm" },
      { key: "llmSystemPrompt", type: "string", touch: "llm" },
      {
        key: "llmTemperature",
        type: "number",
        min: 0,
        max: 2,
        touch: "llm",
        msg: "llmTemperature must be a number between 0 and 2",
      },
      { key: "roastEnabled", type: "boolean", touch: "roast" },
      { key: "roastMinPresent", type: "int", min: 1, touch: "roast" },
      { key: "roastCooldownMinutes", type: "number", min: 0, touch: "roast" },
      {
        key: "roastMinScore",
        type: "int",
        min: 0,
        max: 10,
        touch: "roast",
        msg: "roastMinScore must be an integer 0\u201310",
      },
      // youtubeSaveEnabled / musicBlockedGenres are read live — no re-apply.
      { key: "youtubeSaveEnabled", type: "boolean" },
      {
        key: "musicOpusBitrateKbps",
        type: "int",
        min: 0,
        max: 160,
        touch: "musicBitrate",
        msg: "musicOpusBitrateKbps must be 0 (Auto) or an integer 24–160",
      },
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
      { key: "scOrgStatusUrl", type: "string" },
      { key: "scOrgName", type: "string" },
      { key: "aceStepEnabled", type: "boolean", touch: "aceStep" },
      { key: "aceStepUrl", type: "string", touch: "aceStep" },
      { key: "aceStepAutoFill", type: "boolean", touch: "aceStep" },
      { key: "aceStepTimeoutMs", type: "int", min: 10_000, max: 900_000, touch: "aceStep" },
      { key: "aceStepOutputDir", type: "string", touch: "aceStep" },
      { key: "aceStepMaxFiles", type: "int", min: 0, max: 500, touch: "aceStep" },
      { key: "fileDropEnabled", type: "boolean", touch: "fileDrop" },
      { key: "fileDropPollSec", type: "int", min: 5, touch: "fileDrop" },
      { key: "rightsEnabled", type: "boolean", touch: "rights" },
      { key: "streamBridgeUrl", type: "string", touch: "stream" },
      { key: "pokeCommandsEnabled", type: "boolean" },
      { key: "pokeCommandsPerMinute", type: "int", min: 1, max: 120 },
      { key: "trustProxy", type: "boolean" },
      { key: "trustProxyHops", type: "int", min: 0, max: 5 },
      { key: "harnessIntentAllowDangerous", type: "boolean" },
      { key: "recordingsEnabled", type: "boolean" },
    ];

    if ("scope" in body) {
      config.scope = parseBotScope(body.scope);
    }

    const cfg = config as unknown as Record<string, unknown>;
    for (const spec of FLAT_SETTINGS) {
      if (!(spec.key in body)) continue;
      const v = body[spec.key];
      const fail = (msg: string) => res.status(400).json({ error: msg, code: "VALIDATION_ERROR" });
      if (spec.type === "boolean") {
        if (typeof v !== "boolean") {
          fail(spec.msg ?? `${spec.key} must be a boolean`);
          return;
        }
        cfg[spec.key] = v;
      } else if (spec.type === "string") {
        if (typeof v !== "string") {
          fail(spec.msg ?? `${spec.key} must be a string`);
          return;
        }
        cfg[spec.key] = v.trim();
      } else {
        const isInt = spec.type === "int";
        const ok =
          typeof v === "number" &&
          Number.isFinite(v) &&
          (!isInt || Number.isInteger(v)) &&
          (spec.min === undefined || v >= spec.min) &&
          (spec.max === undefined || v <= spec.max);
        if (!ok) {
          const bound = spec.min !== undefined && spec.min > 0 ? ` >= ${spec.min}` : "";
          fail(
            spec.msg ??
              (isInt
                ? `${spec.key} must be an integer${bound}`
                : `${spec.key} must be a non-negative number`),
          );
          return;
        }
        cfg[spec.key] = v;
      }
      if (spec.touch) touched[spec.touch] = true;
    }

    // Clamp music Opus bitrate: 0 = Auto; else 24–160 kbps (reject bare 1–23).
    if (touched.musicBitrate) {
      const raw = config.musicOpusBitrateKbps;
      if (typeof raw === "number" && raw > 0 && raw < 24) {
        res.status(400).json({
          error: "musicOpusBitrateKbps must be 0 (Auto) or an integer 24–160",
          code: "VALIDATION_ERROR",
        });
        return;
      }
      config.musicOpusBitrateKbps = clampMusicOpusBitrateKbps(raw);
    }

    if ("musicBlockedGenres" in body) {
      const v = body.musicBlockedGenres;
      // Bounded: this list is persisted to config.json and evaluated against
      // every track, so an unbounded array is a durable self-inflicted DoS.
      if (!Array.isArray(v) || v.length > 200 || !v.every((s: unknown) => typeof s === "string")) {
        res.status(400).json({
          error: "musicBlockedGenres must be an array of at most 200 strings",
          code: "VALIDATION_ERROR",
        });
        return;
      }
      // Explicit [] clears the ban (allow all). Non-empty = station policy list.
      config.musicBlockedGenres = v.map((s: string) => s.trim()).filter(Boolean);
    }

    if ("adminGroups" in body) {
      const v = body.adminGroups;
      if (
        !Array.isArray(v) ||
        !v.every((n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0)
      ) {
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
        res.status(400).json({
          error: "rights must be a valid RightsConfig object or null",
          code: "VALIDATION_ERROR",
        });
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
        res
          .status(400)
          .json({ error: "voice.enabled must be a boolean", code: "VALIDATION_ERROR" });
        return;
      }
      if ("respondWithVoice" in patch && typeof patch.respondWithVoice !== "boolean") {
        res
          .status(400)
          .json({ error: "voice.respondWithVoice must be a boolean", code: "VALIDATION_ERROR" });
        return;
      }
      for (const key of ["sttUrl", "ttsUrl", "ttsVoice", "watchword"] as const) {
        if (key in patch && typeof patch[key] !== "string") {
          res
            .status(400)
            .json({ error: `voice.${key} must be a string`, code: "VALIDATION_ERROR" });
          return;
        }
      }
      if ("requireWatchword" in patch && typeof patch.requireWatchword !== "boolean") {
        res
          .status(400)
          .json({ error: "voice.requireWatchword must be a boolean", code: "VALIDATION_ERROR" });
        return;
      }
      if ("duckMusicOnSpeech" in patch && typeof patch.duckMusicOnSpeech !== "boolean") {
        res
          .status(400)
          .json({ error: "voice.duckMusicOnSpeech must be a boolean", code: "VALIDATION_ERROR" });
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
        res
          .status(400)
          .json({ error: "voice.energyThreshold must be a number", code: "VALIDATION_ERROR" });
        return;
      }
      if ("karaokeMode" in patch && typeof patch.karaokeMode !== "boolean") {
        res
          .status(400)
          .json({ error: "voice.karaokeMode must be a boolean", code: "VALIDATION_ERROR" });
        return;
      }
      for (const key of ["ttsBargeIn", "textWakeFallback"] as const) {
        if (key in patch && typeof patch[key] !== "boolean") {
          res
            .status(400)
            .json({ error: `voice.${key} must be a boolean`, code: "VALIDATION_ERROR" });
          return;
        }
      }
      if ("passiveKwsMaxSpeakers" in patch) {
        const v = patch.passiveKwsMaxSpeakers;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 10) {
          res.status(400).json({
            error: "voice.passiveKwsMaxSpeakers must be a number 1–10",
            code: "VALIDATION_ERROR",
          });
          return;
        }
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
          res
            .status(400)
            .json({ error: `radio.${key} must be a boolean`, code: "VALIDATION_ERROR" });
          return;
        }
      }
      for (const key of [
        "everyNSongs",
        "deadAirSeconds",
        "maxBumperSeconds",
        "speechVolumePct",
        "minPresentToBroadcast",
        "cooldownSeconds",
        "maxBumpersPerHour",
      ] as const) {
        const v = patch[key];
        if (key in patch && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
          res.status(400).json({
            error: `radio.${key} must be a non-negative number`,
            code: "VALIDATION_ERROR",
          });
          return;
        }
      }
      // emptyChannelStopSeconds: -1 = off, 0 = immediate, N = grace seconds
      if ("emptyChannelStopSeconds" in patch) {
        const v = patch.emptyChannelStopSeconds;
        if (typeof v !== "number" || !Number.isFinite(v) || v < -1) {
          res.status(400).json({
            error: "radio.emptyChannelStopSeconds must be a number ≥ -1",
            code: "VALIDATION_ERROR",
          });
          return;
        }
      }
      if ("sources" in patch) {
        const valid = new Set([
          "prerecorded",
          "stationId",
          "timeCheck",
          "nowPlaying",
          "doctrine",
          "memory",
        ]);
        if (
          !Array.isArray(patch.sources) ||
          !patch.sources.every((s) => typeof s === "string" && valid.has(s))
        ) {
          res.status(400).json({
            error: "radio.sources must be an array of known source names",
            code: "VALIDATION_ERROR",
          });
          return;
        }
      }
      if ("quietHours" in patch) {
        const ok =
          Array.isArray(patch.quietHours) &&
          patch.quietHours.every(
            (w) => w && typeof w.from === "string" && typeof w.to === "string",
          );
        if (!ok) {
          res.status(400).json({
            error: "radio.quietHours must be [{from,to}] of HH:MM strings",
            code: "VALIDATION_ERROR",
          });
          return;
        }
      }
      for (const key of ["activeProfile", "ttsVoice", "bumperDir"] as const) {
        if (key in patch && typeof patch[key] !== "string") {
          res
            .status(400)
            .json({ error: `radio.${key} must be a string`, code: "VALIDATION_ERROR" });
          return;
        }
      }
      if ("profiles" in patch) {
        const p = patch.profiles;
        const ok =
          typeof p === "object" &&
          p !== null &&
          !Array.isArray(p) &&
          Object.values(p).every(
            (prof) => typeof prof === "object" && prof !== null && !Array.isArray(prof),
          );
        if (!ok) {
          res.status(400).json({
            error: "radio.profiles must be an object of profile objects",
            code: "VALIDATION_ERROR",
          });
          return;
        }
        // Seed-mix fields ride inside profile.music — validate here so a bad
        // value is rejected instead of silently discarded at runtime.
        const validSeedSources = new Set(["local", "youtube", "stream"]);
        for (const [name, prof] of Object.entries(p as Record<string, { music?: unknown }>)) {
          const music = prof.music;
          if (music === undefined) continue;
          if (typeof music !== "object" || music === null || Array.isArray(music)) {
            res.status(400).json({
              error: `radio.profiles.${name}.music must be an object`,
              code: "VALIDATION_ERROR",
            });
            return;
          }
          const m = music as {
            seedSources?: unknown;
            seedExternalRatio?: unknown;
            select?: unknown;
          };
          if ("select" in m && m.select !== undefined) {
            if (typeof m.select !== "object" || m.select === null || Array.isArray(m.select)) {
              res.status(400).json({
                error: `radio.profiles.${name}.music.select must be an object`,
                code: "VALIDATION_ERROR",
              });
              return;
            }
            const mood = (m.select as { mood?: unknown }).mood;
            if (
              mood !== undefined &&
              (!Array.isArray(mood) || mood.some((x) => typeof x !== "string"))
            ) {
              res.status(400).json({
                error: `radio.profiles.${name}.music.select.mood must be an array of strings`,
                code: "VALIDATION_ERROR",
              });
              return;
            }
          }
          if ("seedSources" in m && m.seedSources !== undefined) {
            const ok2 =
              Array.isArray(m.seedSources) &&
              m.seedSources.every((s) => typeof s === "string" && validSeedSources.has(s));
            if (!ok2) {
              res.status(400).json({
                error: `radio.profiles.${name}.music.seedSources must be an array of local|youtube|stream`,
                code: "VALIDATION_ERROR",
              });
              return;
            }
          }
          if ("seedExternalRatio" in m && m.seedExternalRatio !== undefined) {
            const v = m.seedExternalRatio;
            if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
              res.status(400).json({
                error: `radio.profiles.${name}.music.seedExternalRatio must be a number 0–1`,
                code: "VALIDATION_ERROR",
              });
              return;
            }
          }
        }
      }
      if ("clock" in patch) {
        const c = patch.clock;
        const ok =
          typeof c === "object" &&
          c !== null &&
          Array.isArray((c as { wheel?: unknown }).wheel) &&
          (c as { wheel: unknown[] }).wheel.every(
            (s) =>
              s !== null &&
              typeof s === "object" &&
              typeof (s as { slot?: unknown }).slot === "string",
          );
        if (!ok) {
          res.status(400).json({
            error: "radio.clock must have a wheel of {slot} entries",
            code: "VALIDATION_ERROR",
          });
          return;
        }
      }
      if ("classificationFloor" in patch) {
        const f = patch.classificationFloor;
        if (!Array.isArray(f) || !f.every((x) => typeof x === "string")) {
          res.status(400).json({
            error: "radio.classificationFloor must be an array of strings",
            code: "VALIDATION_ERROR",
          });
          return;
        }
        // §6.3: this overrides the presence-based broadcast floor — loud trail.
        logger.warn({ floor: f }, "radio.classificationFloor override set via settings");
      }
      // S1: only known RadioConfig keys pass — an unexpected key is rejected,
      // not silently spread into config.
      const KNOWN_RADIO_KEYS = new Set([
        "enabled",
        "everyNSongs",
        "deadAirSeconds",
        "maxBumperSeconds",
        "speechVolumePct",
        "minPresentToBroadcast",
        "emptyChannelStopSeconds",
        "cooldownSeconds",
        "maxBumpersPerHour",
        "quietHours",
        "sources",
        "memoryBroadcastOptIn",
        "classificationFloor",
        "activeProfile",
        "profiles",
        "clock",
        "ttsVoice",
        "stationIdLines",
        "timeCheckTimezones",
        "bumperDir",
        "analyzer",
        "ratingWeight",
        "autoDjRepeat",
        "harmonicSequencing",
        "smartRotation",
        "audioColor",
        "icecast",
      ]);
      if ("stationIdLines" in patch) {
        const lines = patch.stationIdLines;
        if (!Array.isArray(lines) || !lines.every((x) => typeof x === "string")) {
          res.status(400).json({
            error: "radio.stationIdLines must be an array of strings",
            code: "VALIDATION_ERROR",
          });
          return;
        }
        if (lines.length > 32) {
          res.status(400).json({
            error: "radio.stationIdLines: at most 32 lines",
            code: "VALIDATION_ERROR",
          });
          return;
        }
      }
      if ("timeCheckTimezones" in patch) {
        const zones = patch.timeCheckTimezones;
        if (!Array.isArray(zones) || !zones.every((x) => typeof x === "string")) {
          res.status(400).json({
            error: "radio.timeCheckTimezones must be an array of strings",
            code: "VALIDATION_ERROR",
          });
          return;
        }
        if (zones.length > 8) {
          res.status(400).json({
            error: "radio.timeCheckTimezones: at most 8 zones",
            code: "VALIDATION_ERROR",
          });
          return;
        }
      }
      if ("autoDjRepeat" in patch && patch.autoDjRepeat !== undefined) {
        const r = patch.autoDjRepeat;
        if (typeof r !== "object" || r === null || Array.isArray(r)) {
          res.status(400).json({
            error: "radio.autoDjRepeat must be an object",
            code: "VALIDATION_ERROR",
          });
          return;
        }
        const o = r as { enabled?: unknown; maxPlays?: unknown; cooldownHours?: unknown };
        if ("enabled" in o && o.enabled !== undefined && typeof o.enabled !== "boolean") {
          res.status(400).json({
            error: "radio.autoDjRepeat.enabled must be a boolean",
            code: "VALIDATION_ERROR",
          });
          return;
        }
        if ("maxPlays" in o && o.maxPlays !== undefined) {
          const n = o.maxPlays;
          if (typeof n !== "number" || !Number.isFinite(n) || n < 1 || n > 100) {
            res.status(400).json({
              error: "radio.autoDjRepeat.maxPlays must be a number 1–100",
              code: "VALIDATION_ERROR",
            });
            return;
          }
        }
        if ("cooldownHours" in o && o.cooldownHours !== undefined) {
          const n = o.cooldownHours;
          if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 720) {
            res.status(400).json({
              error: "radio.autoDjRepeat.cooldownHours must be a number 0–720",
              code: "VALIDATION_ERROR",
            });
            return;
          }
        }
      }
      const unknown = Object.keys(patch).filter((k) => !KNOWN_RADIO_KEYS.has(k));
      if (unknown.length > 0) {
        res.status(400).json({
          error: `unknown radio settings: ${unknown.join(", ")}`,
          code: "VALIDATION_ERROR",
        });
        return;
      }
      // Normalize audio color preset (unknown → off).
      if (patch.audioColor !== undefined) {
        patch.audioColor = parseAudioColorPreset(patch.audioColor);
      }
      // The director reads config.radio live at every boundary, so replacing
      // the block hot-applies with no per-bot re-init (unlike voice/llm).
      config.radio = { ...defaultRadioConfig(), ...config.radio, ...patch };
      // R-R6: Icecast tee process follows settings.
      for (const bot of botManager.getAllBots()) {
        try {
          bot.applyIcecastTee?.(config.radio.icecast ?? null);
        } catch {
          /* optional method on fakes */
        }
        try {
          bot.applyAudioColor?.(config.radio.audioColor);
        } catch {
          /* optional */
        }
      }
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
      if (touched.fileDrop)
        bot.updateFileDrop(config.fileDropEnabled ?? false, config.fileDropPollSec);
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
          maxFiles: config.aceStepMaxFiles,
        });
      }
      if (touched.stream) bot.updateStreamBridge(config.streamBridgeUrl ?? "");
      if (touched.voice && config.voice) bot.updateVoice(config.voice);
      if (touched.musicBitrate) {
        try {
          bot.applyMusicOpusBitrate?.(config.musicOpusBitrateKbps);
        } catch {
          /* optional on fakes */
        }
      }
      // SC org URL/name are read live; rebind plugin so !ops picks up Settings.
      bot.refreshScOrgPlugin?.();
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
        ttsVoice: config.voice?.ttsVoice ?? "en_GB-cori-high",
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
      res
        .status(409)
        .json({ error: errorMessage(err, "voice test failed"), code: "VOICE_UNAVAILABLE" });
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
      res
        .status(502)
        .json({ error: errorMessage(err, "memory sync failed"), code: "MEMORY_ERROR" });
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

  // POST /api/bot/ace-step/generate — admin web Generate (Library); same path as !generate.
  router.post("/ace-step/generate", requireAdmin, async (req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({ error: "No bot instance available", code: "NO_BOT" });
      return;
    }
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    if (!prompt) {
      res.status(400).json({ error: "prompt is required", code: "VALIDATION_ERROR" });
      return;
    }
    if (prompt.length > 500) {
      res.status(400).json({ error: "prompt too long (max 500)", code: "VALIDATION_ERROR" });
      return;
    }
    const username = (req as { user?: { username?: string } }).user?.username;
    const invoker = typeof username === "string" && username ? `web:${username}` : "web";
    try {
      const message = await bot.handleAceStepGenerate(prompt, invoker);
      const failed = /^Generation failed|^Music generation is off|^ACE-Step client/i.test(message);
      const rateLimited = /rate limit/i.test(message);
      const busy = /already running/i.test(message);
      res.status(failed ? 502 : rateLimited ? 429 : busy ? 409 : 200).json({
        ok: !failed && !rateLimited && !busy,
        message,
      });
    } catch (err: unknown) {
      res.status(502).json({
        error: errorMessage(err, "generation failed"),
        code: "GENERATE_ERROR",
      });
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
      res
        .status(409)
        .json({ error: "Radio mode is off — enable it in Settings first", code: "RADIO_OFF" });
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

  // POST /api/bot/radio/clear-bumper-cache — drop TTS bumper files (after voice change).
  router.post("/radio/clear-bumper-cache", requireAdmin, async (_req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({ error: "No bot instance available", code: "NO_BOT" });
      return;
    }
    try {
      const result = bot.clearRadioBumperCache();
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      res
        .status(502)
        .json({ error: errorMessage(err, "bumper cache clear failed"), code: "RADIO_ERROR" });
    }
  });

  // POST /api/bot/radio/prewarm-bumpers — TTS-cache station/time liners (and optional
  // doctrine) so live bumpers hit cache instead of waiting on synthesis.
  router.post("/radio/prewarm-bumpers", requireAdmin, async (req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({ error: "No bot instance available", code: "NO_BOT" });
      return;
    }
    const body = (req.body ?? {}) as {
      includeDoctrine?: boolean;
      hoursAhead?: number;
      lines?: unknown;
    };
    const lines = Array.isArray(body.lines)
      ? body.lines.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : undefined;
    const hoursAhead =
      typeof body.hoursAhead === "number" && Number.isFinite(body.hoursAhead)
        ? Math.max(1, Math.min(24, Math.floor(body.hoursAhead)))
        : 12;
    try {
      const result = await bot.prewarmRadioBumpers({
        includeDoctrine: !!body.includeDoctrine,
        hoursAhead,
        lines,
      });
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      res
        .status(502)
        .json({ error: errorMessage(err, "bumper prewarm failed"), code: "RADIO_ERROR" });
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
      res
        .status(409)
        .json({ error: "Knowledge base is disabled in settings", code: "RAG_DISABLED" });
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
          error:
            "RAG substrate not initialized — enable knowledge base and restart with --profile rag",
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
      const data = await fetchJson<{ ok?: boolean; loggedIn?: boolean }>(`${url}/health`, {
        timeoutMs: 5000,
      });
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

  // GET /api/bot/llm/status — admin only (audit L-2026-07-09-1).
  router.get("/llm/status", requireAdmin, async (_req, res) => {
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
    const serverGroups = groupsRaw
      ? groupsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
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

  // ─── Harness cockpit (H1/H2/H5) ───────────────────────────────────────────
  // POST /api/bot/harness/ask — grounded turn with sources + tools + errors.
  router.post("/harness/ask", requireAdmin, async (req, res) => {
    const question =
      typeof req.body?.question === "string"
        ? req.body.question.trim()
        : typeof req.body?.q === "string"
          ? req.body.q.trim()
          : "";
    if (!question) {
      res.status(400).json({ error: "question is required", code: "VALIDATION_ERROR" });
      return;
    }
    const mode = req.body?.mode === "intent" ? "intent" : "ask";
    const dryRun = req.body?.dryRun === true;
    const allowDangerous =
      req.body?.allowDangerous === true || config.harnessIntentAllowDangerous === true;
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({ error: "No bot instance available", code: "NO_BOT" });
      return;
    }
    try {
      const turn = await bot.runHarnessTurn(question, { mode, dryRun, allowDangerous });
      if (turn.error === "LLM is not enabled") {
        res.status(409).json({ error: turn.error, code: "LLM_DISABLED", turn });
        return;
      }
      res.json({ turn });
    } catch (err: unknown) {
      logger.error({ err }, "Harness ask failed");
      res.status(502).json({
        error: errorMessage(err, "harness ask failed"),
        code: "HARNESS_ERROR",
      });
    }
  });

  // GET /api/bot/harness/turns — recent turn ring buffer.
  router.get("/harness/turns", requireAdmin, (req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.json({ turns: [] });
      return;
    }
    const limit = Math.min(
      50,
      Math.max(1, Number.parseInt(String(req.query.limit ?? "30"), 10) || 30),
    );
    res.json({ turns: bot.listHarnessTurns(limit) });
  });

  // ─── Org KG seed (R4) ─────────────────────────────────────────────────────
  // POST /api/bot/org-kg — seed org-scoped fact (never private !remember).
  router.post("/org-kg", requireAdmin, async (req, res) => {
    const fact = typeof req.body?.fact === "string" ? req.body.fact.trim() : "";
    if (!fact) {
      res.status(400).json({ error: "fact is required", code: "VALIDATION_ERROR" });
      return;
    }
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({ error: "No bot instance available", code: "NO_BOT" });
      return;
    }
    try {
      const result = await bot.seedOrgKgFactAsync(fact, "web-admin");
      if (!result.ok) {
        res.status(400).json({ error: result.message, code: "KG_ERROR" });
        return;
      }
      res.json(result);
    } catch (err: unknown) {
      logger.error({ err }, "Org KG seed failed");
      res.status(502).json({ error: errorMessage(err, "org kg seed failed"), code: "KG_ERROR" });
    }
  });

  // GET /api/bot/org-kg — list recent org facts.
  router.get("/org-kg", requireAdmin, (_req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.json({ facts: [] });
      return;
    }
    res.json({ facts: bot.listOrgKgFacts(30) });
  });

  // GET /api/bot/ops/status — org ops brief (G1) for dashboard.
  router.get("/ops/status", requireAdmin, async (_req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({ error: "No bot instance available", code: "NO_BOT" });
      return;
    }
    try {
      const text = await bot.handleOps("status");
      res.json({ text });
    } catch (err: unknown) {
      res.status(502).json({ error: errorMessage(err, "ops failed"), code: "OPS_ERROR" });
    }
  });

  // ─── Memory scopes (H3) ───────────────────────────────────────────────────
  router.get("/memory/scopes", requireAdmin, (req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({ error: "No bot instance available", code: "NO_BOT" });
      return;
    }
    const uid = typeof req.query.uid === "string" ? req.query.uid.trim() : undefined;
    const snapshot = bot.getMemoryScopesSnapshot(uid || undefined);
    res.json(snapshot);
  });

  // GET /api/bot/memory/private?uid= — list private facts (never broadcast).
  router.get("/memory/private", requireAdmin, (req, res) => {
    const uid = typeof req.query.uid === "string" ? req.query.uid.trim() : "";
    if (!uid) {
      res.status(400).json({ error: "uid is required", code: "VALIDATION_ERROR" });
      return;
    }
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({ error: "No bot instance available", code: "NO_BOT" });
      return;
    }
    audit?.record({
      actorId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      targetUserId: uid,
      targetUsername: null,
      action: "memory.private_read",
    });
    res.json({
      scope: "private",
      uid,
      broadcastOk: false,
      facts: bot.listPrivateMemory(uid, 50),
      warning: "Private facts never feed radio memory bumpers or org broadcast.",
    });
  });

  // ─── Recordings (dashboard admin upload/list) ─────────────────────────────
  const dataDir = () => dirname(configPath);

  router.get("/recordings", requireAdmin, (_req, res) => {
    if (!config.recordingsEnabled) {
      res.json({ enabled: false, recordings: [] });
      return;
    }
    res.json({ enabled: true, recordings: listRecordings(dataDir()) });
  });

  router.post("/recordings", requireAdmin, (req, res) => {
    if (!config.recordingsEnabled) {
      res
        .status(409)
        .json({ error: "Recordings are disabled (Settings opt-in)", code: "DISABLED" });
      return;
    }
    const filename = typeof req.body?.filename === "string" ? req.body.filename : "";
    const b64 = typeof req.body?.dataBase64 === "string" ? req.body.dataBase64 : "";
    if (!filename || !b64) {
      res.status(400).json({ error: "filename and dataBase64 required", code: "VALIDATION_ERROR" });
      return;
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      res.status(400).json({ error: "invalid base64", code: "VALIDATION_ERROR" });
      return;
    }
    const meta = writeRecording(dataDir(), filename, buf, {
      mime: typeof req.body?.mime === "string" ? req.body.mime : undefined,
    });
    if (!meta) {
      res.status(400).json({
        error: "invalid filename or empty/too-large payload",
        code: "VALIDATION_ERROR",
      });
      return;
    }
    audit?.record({
      actorId: req.user?.id ?? null,
      actorUsername: req.user?.username ?? null,
      targetUserId: null,
      targetUsername: meta.filename,
      action: "recording.upload",
    });
    res.status(201).json({ ok: true, recording: meta });
  });

  router.get("/recordings/:name", requireAdmin, (req, res) => {
    if (!config.recordingsEnabled) {
      res.status(409).json({ error: "Recordings disabled", code: "DISABLED" });
      return;
    }
    // Sanitize before the header echo — the raw param may carry quotes that
    // break the Content-Disposition quoted-string even when lookup fails.
    const name = safeRecordingBasename(String(req.params.name ?? ""));
    const buf = name ? readRecording(dataDir(), name) : null;
    if (!name || !buf) {
      res.status(404).json({ error: "not found", code: "NOT_FOUND" });
      return;
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.send(buf);
  });

  router.delete("/recordings/:name", requireAdmin, (req, res) => {
    if (!config.recordingsEnabled) {
      res.status(409).json({ error: "Recordings disabled", code: "DISABLED" });
      return;
    }
    const name = String(req.params.name ?? "");
    const ok = deleteRecording(dataDir(), name);
    if (ok) {
      audit?.record({
        actorId: req.user?.id ?? null,
        actorUsername: req.user?.username ?? null,
        targetUserId: null,
        targetUsername: name,
        action: "recording.delete",
      });
    }
    res.json({ ok });
  });

  // G3 — member-readable live status (no admin Settings required)
  router.get("/live", async (_req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.json({
        connected: false,
        nowPlaying: null,
        queue: [],
        radio: null,
        scope: config.scope ?? null,
      });
      return;
    }
    res.json(await bot.getLiveStatus());
  });

  // ─── Voice under music smoke (V1/H4) ──────────────────────────────────────
  router.get("/voice/under-music-check", requireAdmin, (_req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({ error: "No bot instance available", code: "NO_BOT" });
      return;
    }
    try {
      const report = bot.runUnderMusicSmoke();
      res.json(report);
    } catch (err: unknown) {
      res.status(502).json({
        error: errorMessage(err, "under-music check failed"),
        code: "VOICE_CHECK_ERROR",
      });
    }
  });

  // ─── RAG eval (R3) ────────────────────────────────────────────────────────
  router.post("/rag/eval", requireAdmin, async (req, res) => {
    const bot = botManager.getAllBots()[0];
    if (!bot) {
      res.status(409).json({ error: "No bot instance available", code: "NO_BOT" });
      return;
    }
    try {
      const cases = Array.isArray(req.body?.cases) ? req.body.cases : undefined;
      const report = await bot.runRagEval(cases);
      res.json(report);
    } catch (err: unknown) {
      res.status(502).json({
        error: errorMessage(err, "eval failed"),
        code: "EVAL_ERROR",
      });
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
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    res.set("Content-Type", mime);
    res.set("Cache-Control", "no-cache");
    res.send(buf);
  });

  router.put("/:id/avatar", requireAdmin, (req, res) => {
    const id = req.params.id as string;
    const exists = botManager.getBot(id) || botDb.getBotInstances().some((b) => b.id === id);
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
        res.status(400).json({ error: "name, serverAddress, and nickname are required" });
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
      const {
        name,
        serverAddress,
        serverPort,
        nickname,
        defaultChannel,
        channelPassword,
        serverPassword,
      } = req.body;
      // Update in database
      botManager.updateBot(id, {
        name,
        serverAddress,
        serverPort,
        nickname,
        defaultChannel,
        channelPassword,
        serverPassword,
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
