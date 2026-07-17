import express from "express";
import { createSessionRouter } from "../../web/api/session.js";
import { clientIpKeyFn } from "../../web/middleware/client-ip.js";
import { csrfOriginCheck } from "../../web/middleware/csrf.js";
import { createRateLimit } from "../../web/middleware/rateLimit.js";
import type { HttpAppContext, HttpPlugin } from "../types.js";

/**
 * Session surface: login/setup rate limits, CSRF on /api, session router.
 * Body parsers for pre-auth stay at Express default (100kb).
 */
export const registerSession: HttpPlugin = (ctx: HttpAppContext) => {
  const { app, options, users, sessions, audit, logger } = ctx;

  // Anti-DoS: throttle expensive (bcrypt) auth endpoints.
  // 5 req per minute per IP for /login; 3/min for /setup.
  const ipKey = clientIpKeyFn({
    trustProxy: !!options.config.trustProxy,
    trustProxyHops: options.config.trustProxyHops ?? 1,
  });
  const loginLimit = createRateLimit({ capacity: 5, refillPerSec: 5 / 60, keyFn: ipKey });
  const setupLimit = createRateLimit({ capacity: 3, refillPerSec: 3 / 60, keyFn: ipKey });
  app.use("/api/session/login", loginLimit);
  app.use("/api/session/setup", setupLimit);

  // CSRF before session mutators. First-run setup still works same-origin (audit F10).
  app.use("/api", csrfOriginCheck);
  app.use("/api/session", express.json(), createSessionRouter(users, sessions, audit, logger));
};
