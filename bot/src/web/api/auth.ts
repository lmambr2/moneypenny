import { Router } from "express";
import type { MusicProvider } from "../../music/provider.js";
import type { Logger } from "../../logger.js";

export function createAuthRouter(
  youtubeProvider: MusicProvider,
  logger: Logger
): Router {
  const router = Router();

  router.get("/status", async (req, res) => {
    try {
      const platform = (req.query.platform as string) || "youtube";
      const status = await youtubeProvider.getAuthStatus();
      res.json({ platform: youtubeProvider.platform || "youtube", ...status });
    } catch (err) {
      logger.error({ err }, "Auth status check failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/qrcode", async (_req, res) => {
    res.status(400).json({ error: "QR login removed (CN platforms deleted in de-sinicization)" });
  });

  router.get("/qrcode/status", (_req, res) => {
    res.status(400).json({ error: "QR login removed (CN platforms deleted in de-sinicization)" });
  });

  router.post("/sms/send", (_req, res) => {
    res.status(400).json({ error: "SMS login removed (CN platforms deleted in de-sinicization)" });
  });

  router.post("/sms/verify", (_req, res) => {
    res.status(400).json({ error: "SMS login removed (CN platforms deleted in de-sinicization)" });
  });

  router.post("/cookie", (_req, res) => {
    res.status(400).json({ error: "Cookie login removed (CN platforms deleted in de-sinicization)" });
  });

  return router;
}
