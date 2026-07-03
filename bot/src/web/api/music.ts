import { Router } from "express";
import multer from "multer";
import path from "node:path";
import type { MusicProvider } from "../../music/provider.js";
import { YouTubeProvider } from "../../music/youtube.js";
import type { Logger } from "../../logger.js";
import { createRateLimit } from "../middleware/rateLimit.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { errorCode, errorMessage } from "../../util/error.js";
import { multerArray, uploadedFiles } from "./upload.js";
import type { TagStore, TrackTags } from "../../radio/index.js";

const MAX_SEARCH_LIMIT = 50;

function parseSearchLimit(raw: unknown, fallback = 20): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_SEARCH_LIMIT);
}

export function createMusicRouter(
  localProvider: MusicProvider,
  youtubeProvider: MusicProvider,
  streamProvider: MusicProvider,
  logger: Logger,
  tagStore?: TagStore
): Router {
  const router = Router();

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
      const result = await provider.search(query, parseSearchLimit(limit));
      res.json(result);
    } catch (err) {
      logger.error({ err }, "Search failed");
      res.status(500).json({ error: "internal error", code: "INTERNAL_ERROR" });
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
    const { quality } = req.body;
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
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MiB per file
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
    multerArray(upload, "files", 20, {
      fileSizeMessage: "File too large (max 100 MB)",
      unexpectedFileMessage: "Too many files (max 20 per upload)",
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
          msg = "Cannot write to music directory. Ensure MUSIC_DIR on the host is writable by uid 1000 (container user).";
          code = "PERMISSION_DENIED";
          status = 403;
        } else if (/unsupported|format/i.test(msg)) {
          code = "VALIDATION_ERROR";
          status = 400;
        }
        res.status(status).json({ error: msg, code });
      }
    }
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

  // ─── Radio tag overlay (docs/radio.md §9.3) ───────────────────────────────
  // Admin-gated like the rest of the mutating music API. ponytail: @dj web
  // gating needs the rights engine wired into this router (it isn't) — admin
  // covers the common case; @dj-via-web is a follow-up.
  if (tagStore) {
    // Selection-tag fields an editor may set; strings trimmed, numbers coerced.
    const STRING_TAGS = ["genre", "subgenre", "mood", "musicalKey", "keyScale"] as const;
    const NUMBER_TAGS = ["bpm", "energy", "danceability"] as const;

    router.patch("/tracks/:id/tags", requireAdmin, (req, res) => {
      const id = String(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const tags: Partial<TrackTags> = {};
      for (const f of STRING_TAGS) {
        if (typeof body[f] === "string") (tags as Record<string, unknown>)[f] = (body[f] as string).trim();
      }
      for (const f of NUMBER_TAGS) {
        if (body[f] != null && Number.isFinite(Number(body[f]))) (tags as Record<string, unknown>)[f] = Number(body[f]);
      }
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
        res.status(500).json({ error: errorMessage(err, "Tag edit failed"), code: "INTERNAL_ERROR" });
      }
    });

    // Rating: the authenticated web user is the rater (§9.7). Any signed-in user.
    router.post("/tracks/:id/rating", (req, res) => {
      if (!req.user) {
        res.status(401).json({ error: "unauthenticated" });
        return;
      }
      const stars = Number((req.body ?? {}).stars);
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
