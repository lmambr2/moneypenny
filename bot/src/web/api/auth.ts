import { Router } from "express";
import type { MusicProvider } from "../../music/provider.js";
import type { Logger } from "../../logger.js";

/** YouTube provider auth/availability status for the web UI. */
export function createAuthRouter(
  youtubeProvider: MusicProvider,
  logger: Logger,
): Router {
  const router = Router();

  router.get("/status", async (req, res) => {
    try {
      const status = await youtubeProvider.getAuthStatus();
      res.json({ platform: youtubeProvider.platform || "youtube", ...status });
    } catch (err) {
      logger.error({ err }, "Auth status check failed");
      res.status(500).json({ error: "internal error" });
    }
  });

  return router;
}
