import { Router } from "express";
import multer from "multer";
import path from "node:path";
import type { MusicProvider } from "../../music/provider.js";
import { YouTubeProvider } from "../../music/youtube.js";
import type { Logger } from "../../logger.js";
import { createRateLimit } from "../middleware/rateLimit.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

export function createMusicRouter(
  localProvider: MusicProvider,
  youtubeProvider: MusicProvider,
  logger: Logger
): Router {
  const router = Router();

  function getProvider(platform?: string): MusicProvider {
    if (platform === "local") return localProvider;
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
      const localRes = await (localProvider as any).resolve?.(q as string);
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
      if (!q) {
        res.status(400).json({ error: "q (query) is required", code: "VALIDATION_ERROR" });
        return;
      }
      const provider = getProvider(platform as string);
      const result = await provider.search(
        q as string,
        parseInt(limit as string) || 20
      );
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
      const parsedLimit = parseInt(limit as string) || 20;
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

  router.get("/recommend/songs", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      if (!provider.getDailyRecommendSongs) {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      const songs = await provider.getDailyRecommendSongs();
      res.json({ songs });
    } catch (err) {
      logger.error({ err }, "Get daily recommend songs failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/personal/fm", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      if (!provider.getPersonalFm) {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      const songs = await provider.getPersonalFm();
      res.json({ songs });
    } catch (err) {
      logger.error({ err }, "Get personal FM failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/user/playlists", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      if (!provider.getUserPlaylists) {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      const playlists = await provider.getUserPlaylists();
      res.json({ playlists });
    } catch (err) {
      logger.error({ err }, "Get user playlists failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/playlist/:id/detail", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      if (!provider.getPlaylistDetail) {
        res.status(501).json({ error: "Not supported by this provider" });
        return;
      }
      const detail = await provider.getPlaylistDetail(req.params.id);
      if (!detail) {
        res.status(404).json({ error: "Playlist not found" });
        return;
      }
      res.json({ playlist: detail });
    } catch (err) {
      logger.error({ err }, "Get playlist detail failed");
      res.status(500).json({ error: (err as Error).message });
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

  // Multer error handler wrapper (works for .array too) so we return proper JSON for 413/400.
  router.post(
    "/upload",
    requireAdmin,
    (req, res, next) => {
      upload.array("files", 20)(req, res, (err: any) => {
        if (err) {
          if (err.code === "LIMIT_FILE_SIZE") {
            res.status(413).json({ error: "File too large (max 100 MB)", code: "FILE_TOO_LARGE" });
            return;
          }
          if (err.code === "LIMIT_UNEXPECTED_FILE") {
            res.status(400).json({ error: "Too many files (max 20 per upload)", code: "VALIDATION_ERROR" });
            return;
          }
          res.status(400).json({ error: err.message || "Upload error", code: "VALIDATION_ERROR" });
          return;
        }
        next();
      });
    },
    async (req, res) => {
      try {
        const files: any[] = (req as any).files || [];
        if (files.length === 0) {
          res.status(400).json({ error: "No files uploaded", code: "VALIDATION_ERROR" });
          return;
        }

        const hasUpload = typeof (localProvider as any).uploadSong === "function";
        if (!hasUpload) {
          res.status(501).json({ error: "Upload not supported", code: "NOT_IMPLEMENTED" });
          return;
        }

        const uploaded: any[] = [];
        const failed: Array<{ name: string; error: string }> = [];

        for (const f of files) {
          try {
            const song = await (localProvider as any).uploadSong(f.originalname, f.buffer);
            uploaded.push(song);
          } catch (e: any) {
            failed.push({ name: f.originalname, error: e?.message || String(e) });
          }
        }

        // One refresh at the end is sufficient (uploadSong already calls it, but it's idempotent + cheap after first).
        if (typeof (localProvider as any).refresh === "function" && uploaded.length > 0) {
          await (localProvider as any).refresh();
        }

        res.json({
          success: uploaded.length > 0,
          uploaded,
          failed,
          count: uploaded.length,
        });
      } catch (err: any) {
        logger.error({ err }, "Music upload failed");
        let msg = err?.message || "Upload failed";
        let code = "INTERNAL_ERROR";
        let status = 500;
        if (/permission| EACCES |eacces/i.test(msg) || err?.code === "EACCES") {
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

  // ─── Manual library re-index (for files added on the host) ─────────────────
  // Admin-only. Forces LocalProvider to walk the music dir again.
  // Returns the resulting track count. Useful after scp/rsync/NFS drops.
  router.post("/refresh", requireAdmin, async (req, res) => {
    try {
      let trackCount = 0;
      if (typeof (localProvider as any).refresh === "function") {
        trackCount = await (localProvider as any).refresh();
      } else {
        // Fallback: poke a search to trigger lazy index (best effort count)
        const searchRes = await localProvider.search("", 1);
        trackCount = (searchRes?.songs?.length ?? 0);
      }
      res.json({ success: true, trackCount, message: "Library index refreshed" });
    } catch (err: any) {
      logger.error({ err }, "Music refresh failed");
      res.status(500).json({ error: err?.message || "Refresh failed", code: "INTERNAL_ERROR" });
    }
  });

  return router;
}
