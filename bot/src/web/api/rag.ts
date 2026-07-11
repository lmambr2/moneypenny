import path from "node:path";
import { Router } from "express";
import multer from "multer";
import type { DoctrineStore } from "../../data/doctrine.js";
import {
  ExportError,
  exportContentType,
  exportFilename,
  exportMarkdown,
  isPandocAvailable,
  parseExportFormat,
} from "../../docs/export.js";
import type { Logger } from "../../logger.js";
import {
  type IngestedDoc,
  ingestDoctrineDoc,
  MAX_DOCTRINE_FILE_BYTES,
  reindexDoctrine,
  reindexDoctrineSources,
} from "../../rag/doctrine-ingest.js";
import type { RetrievalStore } from "../../rag/index.js";
import {
  reformatDoctrineMarkdown,
  shouldSkipDoctrineReformat,
} from "../../rag/reformat-doctrine.js";
import { errorMessage } from "../../util/error.js";
import { multerArray, uploadedFiles } from "./upload.js";

/**
 * Admin RAG API (ROADMAP Phase 5 substrate + Phase 6 doctrine). `/ingest` +
 * `/query` are the raw primitives; `/doctrine/*` is the document knowledge base —
 * upload `.md` (frontmatter → classification/tags metadata), list, delete, and
 * reindex. Mounted admin-only (see web/server.ts).
 */
export function createRagRouter(
  retrieval: RetrievalStore,
  doctrine: DoctrineStore,
  logger: Logger,
): Router {
  const router = Router();

  // ─── Raw primitives ───────────────────────────────────────────────────────
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
    } catch (err: unknown) {
      logger.error({ err }, "RAG ingest failed");
      res.status(502).json({ error: errorMessage(err, "ingest failed"), code: "RAG_ERROR" });
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
      const chunks = await retrieval.query(
        q,
        topK,
        Array.isArray(req.body?.allowedClassifications)
          ? req.body.allowedClassifications
          : undefined,
      );
      res.json({ q, chunks });
    } catch (err: unknown) {
      logger.error({ err }, "RAG query failed");
      res.status(502).json({ error: errorMessage(err, "query failed"), code: "RAG_ERROR" });
    }
  });

  // ─── Doctrine corpus (Phase 6) ────────────────────────────────────────────
  const ingestDoc = (source: string, content: string) =>
    ingestDoctrineDoc(retrieval, doctrine, source, content);

  const doctrineLimitLabel = "15 MiB";

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_DOCTRINE_FILE_BYTES },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase();
      cb(null, ext === ".md" || ext === ".markdown");
    },
  });

  const DEFAULT_DOCTRINE_TEMPLATE = `---
classification: unclassified
tags: []
---

# Title

Body markdown…
`;

  const normalizeDoctrineSource = (input: string): string | null => {
    const raw = String(input || "")
      .replace(/\\/g, "/")
      .trim();
    if (!raw) return null;
    const withExt = /\.(md|markdown)$/i.test(raw) ? raw : `${raw}.md`;
    return doctrine.safeName(withExt);
  };

  router.get("/doctrine", (_req, res) => {
    res.json({ docs: doctrine.list() });
  });

  /**
   * GET /api/rag/doctrine/hygiene — reindex observability + classification audit (R2).
   * Lists registry docs with classification/tags/chunks and a by-classification summary.
   */
  router.get("/doctrine/hygiene", (_req, res) => {
    const docs = doctrine.list();
    const today = new Date().toISOString().slice(0, 10);
    const byClassification: Record<string, number> = {};
    let expired = 0;
    const enriched = docs.map((d) => {
      const cls = d.classification || "unclassified";
      byClassification[cls] = (byClassification[cls] ?? 0) + 1;
      const isExpired = !!(d.validUntil && d.validUntil < today);
      if (isExpired) expired++;
      return {
        source: d.source,
        classification: cls,
        tags: d.tags,
        chunks: d.chunks,
        bytes: d.bytes,
        validUntil: d.validUntil ?? null,
        expired: isExpired,
        updatedAt: d.updatedAt,
      };
    });
    res.json({
      docCount: docs.length,
      expiredCount: expired,
      byClassification,
      docs: enriched,
      reindex: {
        endpoint: "POST /api/rag/doctrine/reindex",
        command: "!reindex [source.md]",
      },
    });
  });

  router.get("/doctrine/export/capabilities", async (_req, res) => {
    const pandoc = await isPandocAvailable();
    res.json({
      pandoc,
      formats: pandoc ? (["docx", "pdf"] as const) : [],
    });
  });

  router.get("/doctrine/:source/export", async (req, res) => {
    const source = decodeURIComponent(req.params.source);
    if (!doctrine.safeName(source)) {
      res.status(400).json({ error: "invalid doctrine source path", code: "VALIDATION_ERROR" });
      return;
    }
    const format = parseExportFormat(req.query.format) ?? "docx";
    const content = doctrine.readFile(source);
    if (content == null) {
      res.status(404).json({ error: "doctrine not found", code: "NOT_FOUND" });
      return;
    }
    try {
      const buffer = await exportMarkdown(content, format);
      const filename = exportFilename(source, format);
      res.setHeader("Content-Type", exportContentType(format));
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (err: unknown) {
      if (err instanceof ExportError) {
        const status = err.code === "PANDOC_UNAVAILABLE" ? 503 : err.code === "EMPTY" ? 400 : 502;
        res.status(status).json({ error: err.message, code: err.code });
        return;
      }
      logger.error({ err, source, format }, "Doctrine export failed");
      res.status(502).json({ error: errorMessage(err, "export failed"), code: "EXPORT_ERROR" });
    }
  });

  router.post("/doctrine/new", async (req, res) => {
    const source = normalizeDoctrineSource(
      typeof req.body?.source === "string" ? req.body.source : "",
    );
    if (!source) {
      res.status(400).json({
        error: "invalid doctrine source path (must end in .md)",
        code: "VALIDATION_ERROR",
      });
      return;
    }
    if (doctrine.readFile(source) != null) {
      res.status(409).json({ error: "doctrine already exists", code: "CONFLICT", source });
      return;
    }
    const content =
      typeof req.body?.content === "string" && req.body.content.trim()
        ? req.body.content
        : DEFAULT_DOCTRINE_TEMPLATE;
    if (Buffer.byteLength(content) > MAX_DOCTRINE_FILE_BYTES) {
      res
        .status(413)
        .json({ error: `content too large (max ${doctrineLimitLabel})`, code: "VALIDATION_ERROR" });
      return;
    }
    try {
      const ingested = await ingestDoc(source, content);
      res.status(201).json({ ok: true, source, content, ingested });
    } catch (err: unknown) {
      logger.error({ err, source }, "Doctrine create failed");
      res.status(502).json({ error: errorMessage(err, "create failed"), code: "RAG_ERROR" });
    }
  });

  router.get("/doctrine/:source", (req, res) => {
    const source = decodeURIComponent(req.params.source);
    if (!doctrine.safeName(source)) {
      res.status(400).json({ error: "invalid doctrine source path", code: "VALIDATION_ERROR" });
      return;
    }
    const content = doctrine.readFile(source);
    if (content == null) {
      res.status(404).json({ error: "doctrine not found", code: "NOT_FOUND" });
      return;
    }
    res.json({ source, content, meta: doctrine.get(source) });
  });

  router.put("/doctrine/:source", async (req, res) => {
    const source = decodeURIComponent(req.params.source);
    if (!doctrine.safeName(source)) {
      res.status(400).json({ error: "invalid doctrine source path", code: "VALIDATION_ERROR" });
      return;
    }
    const content = typeof req.body?.content === "string" ? req.body.content : "";
    if (!content.trim()) {
      res.status(400).json({ error: "content is required", code: "VALIDATION_ERROR" });
      return;
    }
    if (Buffer.byteLength(content) > MAX_DOCTRINE_FILE_BYTES) {
      res
        .status(413)
        .json({ error: `content too large (max ${doctrineLimitLabel})`, code: "VALIDATION_ERROR" });
      return;
    }
    try {
      const ingested = await ingestDoc(source, content);
      res.json({ ok: true, ingested });
    } catch (err: unknown) {
      logger.error({ err, source }, "Doctrine save failed");
      res.status(502).json({ error: errorMessage(err, "save failed"), code: "RAG_ERROR" });
    }
  });

  router.post(
    "/doctrine",
    multerArray(upload, "files", 20, {
      fileSizeMessage: `File too large (max ${doctrineLimitLabel})`,
    }),
    async (req, res) => {
      const files = uploadedFiles(req);
      if (files.length === 0) {
        res.status(400).json({ error: "No .md files uploaded", code: "VALIDATION_ERROR" });
        return;
      }
      const ingested: IngestedDoc[] = [];
      const failed: Array<{ name: string; error: string }> = [];
      for (const f of files) {
        try {
          ingested.push(await ingestDoc(f.originalname, f.buffer.toString("utf-8")));
        } catch (e: unknown) {
          failed.push({ name: f.originalname, error: errorMessage(e) });
        }
      }
      res.json({ ok: ingested.length > 0, ingested, failed });
    },
  );

  router.delete("/doctrine/:source", async (req, res) => {
    const source = decodeURIComponent(req.params.source);
    if (!doctrine.safeName(source)) {
      res.status(400).json({ error: "invalid doctrine source path", code: "VALIDATION_ERROR" });
      return;
    }
    try {
      await retrieval.purge(source);
      const removed = doctrine.remove(source);
      res.json({ ok: removed, source });
    } catch (err: unknown) {
      logger.error({ err, source }, "Doctrine delete failed");
      res.status(502).json({ error: errorMessage(err, "delete failed"), code: "RAG_ERROR" });
    }
  });

  router.post("/doctrine/reindex", async (req, res) => {
    const sources = Array.isArray(req.body?.sources)
      ? req.body.sources.filter(
          (s: unknown): s is string => typeof s === "string" && s.trim().length > 0,
        )
      : undefined;
    const force = req.body?.force === true;
    try {
      const results =
        sources && sources.length > 0
          ? await reindexDoctrineSources(retrieval, doctrine, sources, { force: force !== false })
          : await reindexDoctrine(retrieval, doctrine);
      res.json({
        ok: true,
        reindexed: results.length,
        docs: results,
        selective: !!(sources && sources.length > 0),
      });
    } catch (err: unknown) {
      logger.error({ err }, "Doctrine reindex failed");
      res.status(502).json({ error: errorMessage(err, "reindex failed"), code: "RAG_ERROR" });
    }
  });

  /**
   * POST /api/rag/doctrine/reformat — normalize frontmatter + ## sections for RAG
   * chunking (admin). Optional body.sources: string[]; default = all on-disk files.
   * Re-ingests only files that changed. Skips ops cheatsheets.
   */
  router.post("/doctrine/reformat", async (req, res) => {
    const only = Array.isArray(req.body?.sources)
      ? req.body.sources.filter(
          (s: unknown): s is string => typeof s === "string" && s.trim().length > 0,
        )
      : undefined;
    try {
      let candidates: string[] = doctrine.files();
      if (only && only.length > 0) {
        const named: string[] = [];
        for (const rawName of only) {
          const safe = doctrine.safeName(rawName);
          if (safe) named.push(safe);
        }
        candidates = named;
      }
      const changed: string[] = [];
      const unchanged: string[] = [];
      const skipped: Array<{ source: string; reason: string }> = [];

      for (const source of candidates) {
        if (shouldSkipDoctrineReformat(source)) {
          skipped.push({ source, reason: "operator cheatsheet" });
          continue;
        }
        const raw = doctrine.readFile(source);
        if (raw == null) {
          skipped.push({ source, reason: "not found" });
          continue;
        }
        const next = reformatDoctrineMarkdown(raw, source);
        if (!next) {
          unchanged.push(source);
          continue;
        }
        if (Buffer.byteLength(next) > MAX_DOCTRINE_FILE_BYTES) {
          skipped.push({ source, reason: "reformatted content too large" });
          continue;
        }
        await ingestDoc(source, next);
        changed.push(source);
      }

      logger.info(
        { changed: changed.length, unchanged: unchanged.length, skipped: skipped.length },
        "Doctrine reformat completed",
      );
      res.json({
        ok: true,
        changed: changed.length,
        unchanged: unchanged.length,
        skipped,
        files: changed,
        reindexedViaIngest: changed.length,
        hint: "Changed files were re-embedded on save. Use Reindex if retrieval still looks stale.",
      });
    } catch (err: unknown) {
      logger.error({ err }, "Doctrine reformat failed");
      res.status(502).json({ error: errorMessage(err, "reformat failed"), code: "RAG_ERROR" });
    }
  });

  return router;
}
