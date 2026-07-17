import type { RequestHandler } from "express";
import type { HttpAppContext, HttpPlugin } from "../types.js";

/**
 * Clickjacking defence — also used by security-headers tests in isolation.
 * CSP frame-ancestors is the modern equivalent of X-Frame-Options.
 */
export const securityHeadersMiddleware: RequestHandler = (_req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  next();
};

/** Trust-proxy hops + security headers + cookie parser prerequisites. */
export const registerSecurity: HttpPlugin = (ctx: HttpAppContext) => {
  const { app, options } = ctx;

  if (options.config.trustProxy) {
    // Hop count for Express trust proxy (matches rate-limit XFF policy).
    const hops = Math.max(1, Math.min(5, options.config.trustProxyHops ?? 1));
    app.set("trust proxy", hops);
  }

  app.use(securityHeadersMiddleware);
};
