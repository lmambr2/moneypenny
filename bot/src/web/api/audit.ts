import { Router } from "express";
import type { AuditStore } from "../../data/audit.js";

export function createAuditRouter(audit: AuditStore): Router {
  const router = Router();
  router.get("/", (req, res) => {
    const limit = clampInt(req.query.limit, 1, 500, 100);
    const offset = clampInt(req.query.offset, 0, 100_000, 0);
    res.json({ entries: audit.list(limit, offset) });
  });
  return router;
}

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === "string" ? parseInt(v, 10) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}
