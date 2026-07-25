import { opusBackendAvailable } from "../../audio/encoder.js";
import type { HttpAppContext, HttpPlugin } from "../types.js";

/** Unauthenticated health + public config (no CSRF, no session). */
export const registerPublicRoutes: HttpPlugin = (ctx: HttpAppContext) => {
  const { app, options } = ctx;

  app.get("/api/health", (_req, res) => {
    // opus.native reports whether the Rust addon loaded, so a remote deploy
    // check can tell a native arm64 image from one that silently fell back
    // to @discordjs/opus (audit C3).
    res.json({ status: "ok", version: "0.1.0", opus: opusBackendAvailable() });
  });

  app.get("/api/config/public-url", (_req, res) => {
    const raw = (options.config.publicUrl ?? "").trim();
    res.json({ publicUrl: raw ? raw.replace(/\/+$/, "") : null });
  });
};
