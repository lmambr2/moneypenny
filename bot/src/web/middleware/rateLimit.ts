import type { Request, Response, NextFunction, RequestHandler } from "express";

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

interface RateLimitOptions {
  /** Bucket capacity (max burst). */
  capacity: number;
  /** Tokens refilled per second. */
  refillPerSec: number;
  /** Optional key function; defaults to req.ip. */
  keyFn?: (req: Request) => string;
}

/**
 * In-memory token-bucket rate limiter.
 *
 * Each unique key (default: req.ip) gets its own bucket. Refills continuously
 * at `refillPerSec` up to `capacity`. Each request consumes 1 token; if no
 * token is available, returns 429 with Retry-After.
 *
 * Buckets evict themselves after 10 minutes of inactivity to bound memory.
 */
export function createRateLimit(options: RateLimitOptions): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const EVICT_AFTER_MS = 10 * 60 * 1000;
  // Periodic eviction to bound memory under attack.
  const evict = setInterval(() => {
    const cutoff = Date.now() - EVICT_AFTER_MS;
    for (const [k, b] of buckets) {
      if (b.lastRefillMs < cutoff) buckets.delete(k);
    }
  }, 60_000);
  // Unref the timer so it doesn't keep the process alive in tests.
  if (typeof (evict as { unref?: () => void }).unref === "function") {
    (evict as { unref: () => void }).unref();
  }

  const keyFn = options.keyFn ?? ((req) => req.ip ?? "unknown");

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const key = keyFn(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: options.capacity, lastRefillMs: now };
      buckets.set(key, b);
    }
    const elapsedSec = (now - b.lastRefillMs) / 1000;
    b.tokens = Math.min(options.capacity, b.tokens + elapsedSec * options.refillPerSec);
    b.lastRefillMs = now;
    if (b.tokens < 1) {
      const waitSec = Math.ceil((1 - b.tokens) / options.refillPerSec);
      res.setHeader("Retry-After", String(waitSec));
      res.status(429).json({ error: "rate limit exceeded" });
      return;
    }
    b.tokens -= 1;
    next();
  };
}
