import { opusBackendAvailable } from "../../audio/encoder.js";
import type { HttpAppContext, HttpPlugin } from "../types.js";

/**
 * Aggregate the LLM route across bots for /api/health.
 *
 * Deliberately probe-free: this endpoint is unauthenticated and drives the
 * Docker healthcheck, so probing an unreachable primary (8s timeout, observed
 * in production) could stall the check and trigger a container restart. This
 * reports what actually served the last completion — free to read, and truer
 * than a probe.
 *
 * Reports no URLs or model names: the endpoint is public and the LLM host is
 * internal infrastructure.
 */
function llmHealth(bots: Array<{ getLlmRoute(): { route: string; at: number } }>): {
  route: string;
  degraded: boolean;
  lastAgeSec: number | null;
} {
  let newest = { route: "none", at: 0 };
  for (const bot of bots) {
    try {
      const r = bot.getLlmRoute();
      if (r.at > newest.at) newest = r;
    } catch {
      // A bot mid-teardown must never fail the healthcheck.
    }
  }
  return {
    route: newest.route,
    // The failure this exists to surface: the primary goes away and every
    // LLM-backed feature silently downgrades to a far weaker fallback model.
    degraded: newest.route === "fallback",
    lastAgeSec: newest.at > 0 ? Math.round((Date.now() - newest.at) / 1000) : null,
  };
}

/** Unauthenticated health + public config (no CSRF, no session). */
export const registerPublicRoutes: HttpPlugin = (ctx: HttpAppContext) => {
  const { app, options } = ctx;

  app.get("/api/health", (_req, res) => {
    // opus.native reports whether the Rust addon loaded. It is the only codec
    // now, so false means the image cannot do audio at all — verify-pi-deploy
    // and any remote check can assert on this.
    res.json({
      status: "ok",
      version: "0.1.0",
      opus: opusBackendAvailable(),
      llm: llmHealth(options.botManager.getAllBots()),
    });
  });

  app.get("/api/config/public-url", (_req, res) => {
    const raw = (options.config.publicUrl ?? "").trim();
    res.json({ publicUrl: raw ? raw.replace(/\/+$/, "") : null });
  });
};
