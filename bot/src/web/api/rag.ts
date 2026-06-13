import { Router } from "express";
import type { RetrievalStore } from "../../rag/index.js";
import type { Logger } from "../../logger.js";

/**
 * Admin RAG API (ROADMAP Phase 5): manual ingest + query over the vector store,
 * for validation and ad-hoc doc adds. Phase 6 layers git-driven ingestion, a
 * doc-upload UI, and citations / rights-gating on top of these same primitives.
 * Mounted admin-only (see web/server.ts).
 */
export function createRagRouter(retrieval: RetrievalStore, logger: Logger): Router {
  const router = Router();

  router.post("/ingest", async (req, res) => {
    const source = typeof req.body?.source === "string" ? req.body.source.trim() : "";
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!source || !text.trim()) {
      res.status(400).json({ error: "source and text are required", code: "VALIDATION_ERROR" });
      return;
    }
    try {
      const chunks = await retrieval.ingest(source, text, req.body?.metadata ?? {});
      res.json({ ok: true, source, chunks });
    } catch (err: any) {
      logger.error({ err }, "RAG ingest failed");
      res.status(502).json({ error: err?.message || "ingest failed", code: "RAG_ERROR" });
    }
  });

  router.post("/query", async (req, res) => {
    const q = typeof req.body?.q === "string" ? req.body.q.trim() : "";
    if (!q) {
      res.status(400).json({ error: "q is required", code: "VALIDATION_ERROR" });
      return;
    }
    const topK = Number.isInteger(req.body?.topK) ? req.body.topK : undefined;
    try {
      const chunks = await retrieval.query(q, topK);
      res.json({ q, chunks });
    } catch (err: any) {
      logger.error({ err }, "RAG query failed");
      res.status(502).json({ error: err?.message || "query failed", code: "RAG_ERROR" });
    }
  });

  return router;
}
