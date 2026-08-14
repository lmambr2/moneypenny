import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import type { Logger } from "../../logger.js";
import type { LocalProvider } from "../../music/local.js";
import type { PlaybackBlacklist } from "../../music/playback-blacklist.js";
import { banProtectedMessage, isBanProtected } from "../../music/playback-blacklist.js";
import type { MusicProvider } from "../../music/provider.js";
import { guessTrackTags } from "../../music/tag-guess.js";
import type { RadioAnalyzer, TagStore, TrackTags } from "../../radio/index.js";
import type { RadioConfig } from "../../radio/types.js";
import { errorCode, errorMessage } from "../../util/error.js";
import { createRateLimit } from "../middleware/rateLimit.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { parseWithSchema } from "../validate.js";
import { multerArray, uploadedFiles } from "./upload.js";

/** Phase 0 no-op; still validated so the endpoint cannot reflect arbitrary input. */
const qualitySchema = z.object({
  quality: z.enum(["low", "medium", "high", "lossless"]).optional(),
});

function asLocalProvider(provider: MusicProvider): LocalProvider | null {
  return "listForAnalysis" in provider &&
    typeof (provider as LocalProvider).listForAnalysis === "function"
    ? (provider as LocalProvider)
    : null;
}

export interface MusicRouterOptions {
  tagStore?: TagStore;
  /** Admin-curated ban list — blocks playback without deleting files. */
  playbackBlacklist?: PlaybackBlacklist;
  /** Artists the ban endpoint must refuse (config.playbackBanProtectedArtists). */
  getBanProtectedArtists?: () => readonly string[] | undefined;
  radioAnalyzer?: RadioAnalyzer;
  getRadioConfig?: () => RadioConfig;
  /**
   * When set, PATCH /tracks/:id/tags allows this web user (in addition to
   * platform admins). Used for `@dj` / `radio.tags` rank-gating.
   */
  canEditTags?: (user: {
    id: string;
    username: string;
    role: "admin" | "member";
  }) => boolean | Promise<boolean>;
  /**
   * One-shot LLM Q&A (bot.askLlm). Enables POST /tracks/:id/tags/guess
   * (docs/radio.md §9.5 AI-assisted genre/mood).
   */
  askLlm?: (question: string) => Promise<string | null>;
}

const MAX_SEARCH_LIMIT = 50;
/** Library browse (empty local search) can be larger — UI uses a scroll panel. */
const MAX_LIBRARY_LIST = 2000;

function parseSearchLimit(raw: unknown, fallback = 20): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_SEARCH_LIMIT);
}

function parseLibraryLimit(raw: unknown, fallback = 500): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_LIBRARY_LIST);
}

export function createMusicRouter(
  localProvider: MusicProvider,
  youtubeProvider: MusicProvider,
  streamProvider: MusicProvider,
  logger: Logger,
  options: MusicRouterOptions = {},
): Router {
  const {
    tagStore,
    playbackBlacklist,
    radioAnalyzer,
    getRadioConfig,
    canEditTags,
    askLlm,
    getBanProtectedArtists,
  } = options;
  const router = Router();

  /** Admin always; optional canEditTags for @dj / radio.tags web editors. */
  async function requireTagEditor(
    req: import("express").Request,
    res: import("express").Response,
    next: import("express").NextFunction,
  ): Promise<void> {
    if (!req.user) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    if (req.user.role === "admin") {
      next();
      return;
    }
    if (canEditTags) {
      try {
        if (await canEditTags(req.user)) {
          next();
          return;
        }
      } catch (err) {
        logger.warn({ err }, "canEditTags check failed");
      }
    }
    res.status(403).json({
      error: "forbidden",
      message: "Admin or DJ (radio.tags) privileges are required to edit track tags.",
      code: "PERMISSION_DENIED",
    });
  }

  function scheduleIngestAnalysis(trackIds: string[]): void {
    const cfg = getRadioConfig?.();
    if (!radioAnalyzer || !cfg?.analyzer?.enabled || !cfg.analyzer.onIngest) return;
    const local = asLocalProvider(localProvider);
    if (!local) return;
    void (async () => {
      for (const id of trackIds) {
        try {
          const absPath = await local.pathForId(id);
          if (absPath) await radioAnalyzer.analyzeTrack({ absPath, trackKey: id });
        } catch (err) {
          logger.warn({ err, trackId: id }, "radio analyzer: on-ingest failed");
        }
      }
    })();
  }

  function getProvider(platform?: string): MusicProvider {
    if (platform === "local") return localProvider;
    if (platform === "stream") return streamProvider;
    return youtubeProvider;
  }

  router.get("/resolve", async (req, res) => {
    try {
      const { q } = req.query;
      if (!q) {
        res.status(400).json({ error: "q is required", code: "VALIDATION_ERROR" });
        return;
      }
      // Prefer local resolve (the hook)
      const localRes = await localProvider.resolve?.(q as string);
      if (localRes) {
        res.json({ resolved: true, type: localRes.type, item: localRes.item });
        return;
      }
      res.json({ resolved: false });
    } catch (err) {
      logger.error({ err }, "Resolve failed");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
    }
  });

  const searchLimit = createRateLimit({
    capacity: 30,
    refillPerSec: 2,
    message: (waitSec) => `Search rate limited (indexing is expensive). Please wait ${waitSec}s.`,
  });
  router.get("/search", searchLimit, async (req, res) => {
    try {
      const { q, platform, limit } = req.query;
      const query = typeof q === "string" ? q : "";
      const plat = typeof platform === "string" ? platform : "youtube";
      // LocalProvider uses an empty query to list library tracks (Home/Library views).
      if (!query && plat !== "local") {
        res.status(400).json({ error: "q (query) is required", code: "VALIDATION_ERROR" });
        return;
      }
      const provider = getProvider(plat);
      // Empty local query = library browse — allow a higher limit for the scrollable UI.
      const lim =
        !query && plat === "local" ? parseLibraryLimit(limit, 500) : parseSearchLimit(limit);
      const result = await provider.search(query, lim);
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Search failed");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
    }
  });

  // Full local library list for the Library page scroll panel.
  router.get("/library", async (req, res) => {
    try {
      const lim = parseLibraryLimit(req.query.limit, 2000);
      const result = await localProvider.search("", lim);
      res.json({ songs: result.songs ?? [], count: result.songs?.length ?? 0 });
    } catch (err) {
      logger.error({ err }, "Library list failed");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
    }
  });

  // ── Playback blacklist (admin) ──────────────────────────────────────────
  // Ban a track id from search/play/radio without deleting the file. Library
  // browse still lists it so admins can unban.

  router.get("/blacklist", requireAdmin, (_req, res) => {
    if (!playbackBlacklist) {
      res.status(501).json({ error: "Blacklist not available", code: "NOT_IMPLEMENTED" });
      return;
    }
    const entries = playbackBlacklist.list();
    res.json({ entries, keys: entries.map((e) => e.trackKey) });
  });

  router.post("/blacklist", requireAdmin, (req, res) => {
    if (!playbackBlacklist) {
      res.status(501).json({ error: "Blacklist not available", code: "NOT_IMPLEMENTED" });
      return;
    }
    try {
      const body = req.body ?? {};
      const trackKey =
        typeof body.trackKey === "string"
          ? body.trackKey
          : typeof body.id === "string"
            ? body.id
            : "";
      if (!trackKey.trim()) {
        res.status(400).json({ error: "trackKey (or id) is required", code: "VALIDATION_ERROR" });
        return;
      }
      if (trackKey.includes("..") || trackKey.includes("/") || trackKey.includes("\\")) {
        res.status(400).json({ error: "Invalid track key", code: "VALIDATION_ERROR" });
        return;
      }
      // Same protection as chat !ban — otherwise the web UI is a way around it.
      const protectedArtists = getBanProtectedArtists?.();
      const candidate = {
        name: typeof body.name === "string" ? body.name : null,
        artist: typeof body.artist === "string" ? body.artist : null,
      };
      if (isBanProtected(candidate, protectedArtists)) {
        res.status(403).json({
          error: banProtectedMessage({
            name: candidate.name ?? undefined,
            artist: candidate.artist ?? undefined,
          }),
          code: "BAN_PROTECTED",
        });
        return;
      }
      const entry = playbackBlacklist.add({
        trackKey: trackKey.trim(),
        platform: typeof body.platform === "string" ? body.platform : null,
        name: typeof body.name === "string" ? body.name : null,
        artist: typeof body.artist === "string" ? body.artist : null,
        reason: typeof body.reason === "string" ? body.reason : null,
        createdBy: req.user?.username ?? req.user?.id ?? null,
      });
      res.json({ success: true, entry });
    } catch (err) {
      logger.error({ err }, "Blacklist add failed");
      res
        .status(500)
        .json({ error: errorMessage(err, "Blacklist add failed"), code: "INTERNAL_ERROR" });
    }
  });

  router.delete("/blacklist/:id", requireAdmin, (req, res) => {
    if (!playbackBlacklist) {
      res.status(501).json({ error: "Blacklist not available", code: "NOT_IMPLEMENTED" });
      return;
    }
    try {
      const id = String(req.params.id ?? "");
      if (!id || id.includes("..") || id.includes("/") || id.includes("\\")) {
        res.status(400).json({ error: "Invalid track id", code: "VALIDATION_ERROR" });
        return;
      }
      const removed = playbackBlacklist.remove(id);
      if (!removed) {
        res.status(404).json({ error: "Not on blacklist", code: "NOT_FOUND" });
        return;
      }
      res.json({ success: true, removed: true });
    } catch (err) {
      logger.error({ err }, "Blacklist remove failed");
      res
        .status(500)
        .json({ error: errorMessage(err, "Blacklist remove failed"), code: "INTERNAL_ERROR" });
    }
  });

  // Admin: delete a local library track (file under MUSIC_DIR) by opaque id.
  router.delete("/tracks/:id", requireAdmin, async (req, res) => {
    try {
      const deleteSong = localProvider.deleteSong;
      if (!deleteSong) {
        res.status(501).json({ error: "Delete not supported", code: "NOT_IMPLEMENTED" });
        return;
      }
      const id = String(req.params.id ?? "");
      if (!id || id.includes("..") || id.includes("/") || id.includes("\\")) {
        res.status(400).json({ error: "Invalid track id", code: "VALIDATION_ERROR" });
        return;
      }
      const out = await deleteSong.call(localProvider, id);
      try {
        tagStore?.removeTrack(id);
      } catch (tagErr) {
        logger.warn({ err: tagErr, id }, "tag cleanup after delete failed");
      }
      res.json({ success: true, ...out });
    } catch (err: unknown) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : "";
      if (code === "NOT_FOUND") {
        res.status(404).json({ error: errorMessage(err, "Track not found"), code: "NOT_FOUND" });
        return;
      }
      if (code === "FORBIDDEN") {
        res.status(403).json({ error: errorMessage(err, "Forbidden"), code: "FORBIDDEN" });
        return;
      }
      logger.error({ err }, "Music delete failed");
      res.status(500).json({ error: errorMessage(err, "Delete failed"), code: "INTERNAL_ERROR" });
    }
  });

  router.get("/search/all", searchLimit, async (req, res) => {
    try {
      const { q, limit } = req.query;
      if (!q) {
        res.status(400).json({ error: "q (query) is required", code: "VALIDATION_ERROR" });
        return;
      }
      const parsedLimit = parseSearchLimit(limit);
      // Phase 0: only YouTube is wired. Local + Stream will participate here later.
      const result = await getProvider("youtube").search(q as string, parsedLimit);
      res.json({
        songs: result.songs,
        albums: result.albums,
        playlists: result.playlists,
      });
    } catch (err) {
      logger.error({ err }, "Unified search failed");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
    }
  });

  router.get("/song/:id", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      const song = await provider.getSongDetail(req.params.id);
      if (!song) {
        res.status(404).json({ error: "Song not found" });
        return;
      }
      res.json(song);
    } catch (err) {
      logger.error({ err }, "Player detail error");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
    }
  });

  router.get("/playlist/:id", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      const songs = await provider.getPlaylistSongs(req.params.id);
      res.json({ songs });
    } catch (err) {
      logger.error({ err }, "Player detail error");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
    }
  });

  router.get("/recommend/playlists", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      const playlists = await provider.getRecommendPlaylists();
      res.json({ playlists });
    } catch (err) {
      logger.error({ err }, "Player detail error");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
    }
  });

  router.get("/album/:id", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      const songs = await provider.getAlbumSongs(req.params.id);
      res.json({ songs });
    } catch (err) {
      logger.error({ err }, "Player detail error");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
    }
  });

  router.get("/lyrics/:id", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      const lyrics = await provider.getLyrics(req.params.id);
      res.json({ lyrics });
    } catch (err) {
      logger.error({ err }, "Player detail error");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
    }
  });

  // Current quality (YouTube has no quality selector in the same way)
  router.get("/quality", (_req, res) => {
    res.json({ local: "original", youtube: "default" });
  });

  router.post("/quality", (req, res) => {
    // `req.body` is undefined when no JSON body is sent, so destructuring it
    // directly threw a 500. Validate rather than echo arbitrary input back.
    const parsed = parseWithSchema(qualitySchema, req.body ?? {});
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error, code: "VALIDATION_ERROR" });
      return;
    }
    const { quality } = parsed.data;
    logger.info({ quality }, "Quality change requested (no-op in Phase 0)");
    res.json({ success: true, quality });
  });

  // ─── Web UI music upload (local library only) ─────────────────────────────
  // Admin-only. Writes into a dedicated `uploads/` subdir under the
  // LocalProvider's musicDir (see LocalProvider.uploadSong for the security/audit rationale).
  // Must be writable by the container uid. Triggers re-index so files appear
  // in search/library immediately. Supports multiple files. No restart required.
  const upload = multer({
    storage: multer.memoryStorage(),
    // Cap memory DoS: 40 MiB × 5 files (admin-only). Disk streaming is a follow-up.
    limits: { fileSize: 40 * 1024 * 1024, files: 5 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const allowed = [".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".wma", ".opus"];
      if (allowed.includes(ext)) {
        cb(null, true);
      } else {
        cb(new Error("Unsupported audio format"));
      }
    },
  });

  router.post(
    "/upload",
    requireAdmin,
    multerArray(upload, "files", 5, {
      fileSizeMessage: "File too large (max 40 MB)",
      unexpectedFileMessage: "Too many files (max 5 per upload)",
    }),
    async (req, res) => {
      try {
        const files = uploadedFiles(req);
        if (files.length === 0) {
          res.status(400).json({ error: "No files uploaded", code: "VALIDATION_ERROR" });
          return;
        }

        const uploadSong = localProvider.uploadSong;
        if (!uploadSong) {
          res.status(501).json({ error: "Upload not supported", code: "NOT_IMPLEMENTED" });
          return;
        }

        const uploaded: Awaited<ReturnType<NonNullable<typeof uploadSong>>>[] = [];
        const failed: Array<{ name: string; error: string }> = [];

        for (const f of files) {
          try {
            const song = await uploadSong.call(localProvider, f.originalname, f.buffer);
            uploaded.push(song);
          } catch (e: unknown) {
            failed.push({ name: f.originalname, error: errorMessage(e) });
          }
        }

        // One refresh at the end is sufficient (uploadSong already calls it, but it's idempotent + cheap after first).
        if (localProvider.refresh && uploaded.length > 0) {
          await localProvider.refresh();
        }

        if (uploaded.length > 0) {
          scheduleIngestAnalysis(uploaded.map((s) => s.id));
        }

        res.json({
          success: uploaded.length > 0,
          uploaded,
          failed,
          count: uploaded.length,
        });
      } catch (err: unknown) {
        logger.error({ err }, "Music upload failed");
        let msg = errorMessage(err, "Upload failed");
        let code = "INTERNAL_ERROR";
        let status = 500;
        if (/permission| EACCES |eacces/i.test(msg) || errorCode(err) === "EACCES") {
          msg =
            "Cannot write to music directory. Ensure MUSIC_DIR on the host is writable by uid 1000 (container user).";
          code = "PERMISSION_DENIED";
          status = 403;
        } else if (/unsupported|format/i.test(msg)) {
          code = "VALIDATION_ERROR";
          status = 400;
        }
        res.status(status).json({ error: msg, code });
      }
    },
  );

  // GET /api/music/stats — indexed local track count (for Settings / dashboard).
  router.get("/stats", async (_req, res) => {
    try {
      let trackCount = 0;
      if ("getTrackCount" in localProvider && typeof localProvider.getTrackCount === "function") {
        trackCount = await localProvider.getTrackCount();
      } else if (localProvider.refresh) {
        trackCount = await localProvider.refresh();
      }
      res.json({ trackCount, platform: "local" });
    } catch (err) {
      logger.error({ err }, "Music stats failed");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
    }
  });

  // ─── Manual library re-index (for files added on the host) ─────────────────
  // Admin-only. Forces LocalProvider to walk the music dir again.
  // Returns the resulting track count. Useful after scp/rsync/NFS drops.
  router.post("/refresh", requireAdmin, async (req, res) => {
    try {
      let trackCount = 0;
      if (localProvider.refresh) {
        trackCount = await localProvider.refresh();
      } else {
        const searchRes = await localProvider.search("", 1);
        trackCount = searchRes?.songs?.length ?? 0;
      }
      res.json({ success: true, trackCount, message: "Library index refreshed" });
    } catch (err: unknown) {
      logger.error({ err }, "Music refresh failed");
      res.status(500).json({ error: errorMessage(err, "Refresh failed"), code: "INTERNAL_ERROR" });
    }
  });

  // ─── Radio analyzer (docs/radio.md §9.5, OQ2) ─────────────────────────────
  if (radioAnalyzer) {
    router.get("/analyze/status", requireAdmin, async (_req, res) => {
      try {
        const cfg = getRadioConfig?.();
        res.json({
          enabled: !!cfg?.analyzer?.enabled,
          onIngest: !!cfg?.analyzer?.onIngest,
          available: await radioAnalyzer.available(),
        });
      } catch (err) {
        logger.error({ err }, "analyzer status failed");
        res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
      }
    });

    router.post("/analyze", requireAdmin, async (req, res) => {
      const cfg = getRadioConfig?.();
      if (!cfg?.analyzer?.enabled) {
        res.status(400).json({
          error: "Radio analyzer is disabled — enable it in Settings → Radio/DJ",
          code: "DISABLED",
        });
        return;
      }
      const local = asLocalProvider(localProvider);
      if (!local) {
        res
          .status(501)
          .json({ error: "Analyzer requires the local music provider", code: "NOT_IMPLEMENTED" });
        return;
      }
      const force = !!(req.body as { force?: boolean })?.force;
      const trackId = (req.body as { trackId?: string })?.trackId?.trim();
      try {
        if (trackId) {
          const absPath = await local.pathForId(trackId);
          if (!absPath) {
            res.status(404).json({ error: "Track not found in library index", code: "NOT_FOUND" });
            return;
          }
          const result = await radioAnalyzer.analyzeTrack(
            { absPath, trackKey: trackId },
            { force },
          );
          res.json({
            success: true,
            trackId,
            analyzed: result ? 1 : 0,
            skipped: result ? 0 : 1,
            result,
            tags: tagStore?.get(trackId) ?? null,
          });
          return;
        }
        const tracks = await local.listForAnalysis();
        const tally = await radioAnalyzer.analyzeAll(tracks, { force });
        res.json({ success: true, trackCount: tracks.length, ...tally });
      } catch (err) {
        logger.error({ err }, "analyzer batch failed");
        res
          .status(500)
          .json({ error: errorMessage(err, "Analyze failed"), code: "INTERNAL_ERROR" });
      }
    });
  }

  // ─── Radio tag overlay (docs/radio.md §9.3) ───────────────────────────────
  // Admin or rank-gated DJ (radio.tags) via canEditTags — not bare members.
  if (tagStore) {
    // Selection-tag fields an editor may set; strings trimmed, numbers coerced.
    const STRING_TAGS = ["genre", "subgenre", "mood", "musicalKey", "keyScale"] as const;
    const NUMBER_TAGS = ["bpm", "energy", "danceability"] as const;

    function parseTagBody(body: Record<string, unknown>): Partial<TrackTags> {
      const tags: Partial<TrackTags> = {};
      for (const f of STRING_TAGS) {
        if (typeof body[f] === "string")
          (tags as Record<string, unknown>)[f] = (body[f] as string).trim();
      }
      for (const f of NUMBER_TAGS) {
        if (body[f] != null && Number.isFinite(Number(body[f])))
          (tags as Record<string, unknown>)[f] = Number(body[f]);
      }
      return tags;
    }

    // Bulk apply (registered before :id so "bulk" is not captured as an id).
    router.patch("/tracks/tags/bulk", requireTagEditor, (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const idsRaw = body.ids;
      const ids = Array.isArray(idsRaw)
        ? idsRaw
            .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
            .map((s) => s.trim())
        : [];
      if (ids.length === 0) {
        res
          .status(400)
          .json({ error: "ids must be a non-empty string array", code: "VALIDATION_ERROR" });
        return;
      }
      if (ids.length > 200) {
        res.status(400).json({ error: "ids limited to 200 per request", code: "VALIDATION_ERROR" });
        return;
      }
      const tags = parseTagBody(body);
      const hasBumper = typeof body.bumper === "boolean";
      if (Object.keys(tags).length === 0 && !hasBumper) {
        res.status(400).json({
          error: "provide at least one tag field or bumper",
          code: "VALIDATION_ERROR",
        });
        return;
      }
      try {
        let updated = 0;
        for (const id of ids) {
          if (Object.keys(tags).length > 0) tagStore.upsert(id, tags, "manual");
          if (hasBumper) {
            tagStore.setBumper(id, {
              bumper: body.bumper as boolean,
              bumperKind: typeof body.bumperKind === "string" ? body.bumperKind : undefined,
              opsScope: typeof body.opsScope === "string" ? body.opsScope : undefined,
            });
          }
          updated++;
        }
        res.json({ success: true, updated, ids });
      } catch (err) {
        logger.error({ err }, "bulk tag edit failed");
        res
          .status(500)
          .json({ error: errorMessage(err, "Bulk tag edit failed"), code: "INTERNAL_ERROR" });
      }
    });

    router.get("/tracks/:id/tags", (req, res) => {
      const id = String(req.params.id);
      res.json({ id, tags: tagStore.get(id), rating: tagStore.getRating(id) });
    });

    router.patch("/tracks/:id/tags", requireTagEditor, (req, res) => {
      const id = String(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const tags = parseTagBody(body);
      try {
        if (Object.keys(tags).length > 0) tagStore.upsert(id, tags, "manual");
        // Bumper flag is orthogonal (§9.2) — set only when the field is present.
        if (typeof body.bumper === "boolean") {
          tagStore.setBumper(id, {
            bumper: body.bumper,
            bumperKind: typeof body.bumperKind === "string" ? body.bumperKind : undefined,
            opsScope: typeof body.opsScope === "string" ? body.opsScope : undefined,
          });
        }
        res.json({ success: true, tags: tagStore.get(id) });
      } catch (err) {
        logger.error({ err, id }, "tag edit failed");
        res
          .status(500)
          .json({ error: errorMessage(err, "Tag edit failed"), code: "INTERNAL_ERROR" });
      }
    });

    // LLM best-guess genre/subgenre/mood from title+artist (not audio). source=api.
    const guessLimit = createRateLimit({
      capacity: 12,
      refillPerSec: 0.25,
      message: (waitSec) => `Tag guess rate limited (LLM). Please wait ${waitSec}s.`,
    });
    router.post("/tracks/:id/tags/guess", requireTagEditor, guessLimit, async (req, res) => {
      if (!askLlm) {
        res.status(503).json({
          error: "LLM tag guess is unavailable (bot not wired)",
          code: "LLM_UNAVAILABLE",
        });
        return;
      }
      const id = String(req.params.id);
      try {
        const detail = await localProvider.getSongDetail(id);
        if (!detail) {
          res.status(404).json({ error: "Track not found in library index", code: "NOT_FOUND" });
          return;
        }
        const existing = tagStore.get(id) ?? undefined;
        const guessed = await guessTrackTags(askLlm, {
          name: detail.name,
          artist: detail.artist,
          album: detail.album,
          existing: existing
            ? { genre: existing.genre, subgenre: existing.subgenre, mood: existing.mood }
            : undefined,
        });
        if (!guessed) {
          res.status(502).json({
            error:
              "LLM returned no usable tags (disabled, empty reply, or unparseable). Check Settings → LLM.",
            code: "LLM_GUESS_FAILED",
          });
          return;
        }
        tagStore.upsert(id, guessed, "api");
        res.json({
          success: true,
          id,
          guessed,
          tags: tagStore.get(id),
        });
      } catch (err) {
        logger.error({ err, id }, "LLM tag guess failed");
        res
          .status(500)
          .json({ error: errorMessage(err, "Tag guess failed"), code: "INTERNAL_ERROR" });
      }
    });

    // Rating: the authenticated web user is the rater (§9.7). Any signed-in user.
    router.post("/tracks/:id/rating", (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      const stars = Number(req.body?.stars);
      if (!(stars >= 1 && stars <= 5)) {
        res.status(400).json({ error: "stars must be 1..5", code: "BAD_REQUEST" });
        return;
      }
      tagStore.rate(req.params.id, `web:${req.user.id}`, stars);
      res.json({ success: true, rating: tagStore.getRating(req.params.id) });
    });

    // Remove the caller's rating.
    router.delete("/tracks/:id/rating", (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      const removed = tagStore.unrate(req.params.id, `web:${req.user.id}`);
      res.json({ success: true, removed, rating: tagStore.getRating(req.params.id) });
    });
  }

  return router;
}
