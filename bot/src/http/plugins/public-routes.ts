import type { HttpAppContext, HttpPlugin } from "../types.js";

/** Unauthenticated health + public config (no CSRF, no session). */
export const registerPublicRoutes: HttpPlugin = (ctx: HttpAppContext) => {
  const { app, options } = ctx;

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", version: "0.1.0" });
  });

  app.get("/api/config/public-url", (_req, res) => {
    const raw = (options.config.publicUrl ?? "").trim();
    res.json({ publicUrl: raw ? raw.replace(/\/+$/, "") : null });
  });
};
