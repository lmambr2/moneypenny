import { Router } from "express";
import type { MusicProvider } from "../../music/provider.js";
import { YouTubeProvider } from "../../music/youtube.js";
import type { Logger } from "../../logger.js";

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
        res.status(400).json({ error: "q is required" });
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
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/search", async (req, res) => {
    try {
      const { q, platform, limit } = req.query;
      if (!q) {
        res.status(400).json({ error: "q (query) is required" });
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
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/search/all", async (req, res) => {
    try {
      const { q, limit } = req.query;
      if (!q) {
        res.status(400).json({ error: "q (query) is required" });
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
      res.status(500).json({ error: (err as Error).message });
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
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/playlist/:id", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      const songs = await provider.getPlaylistSongs(req.params.id);
      res.json({ songs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/recommend/playlists", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      const playlists = await provider.getRecommendPlaylists();
      res.json({ playlists });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/album/:id", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      const songs = await provider.getAlbumSongs(req.params.id);
      res.json({ songs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/lyrics/:id", async (req, res) => {
    try {
      const provider = getProvider(req.query.platform as string);
      const lyrics = await provider.getLyrics(req.params.id);
      res.json({ lyrics });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
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

  return router;
}
