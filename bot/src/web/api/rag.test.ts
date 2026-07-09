import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DoctrineStore } from "../../data/doctrine.js";
import * as exportMod from "../../docs/export.js";
import { createRagRouter } from "./rag.js";

describe("rag router", () => {
  let dir: string;
  let doctrine: DoctrineStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rag-api-"));
    doctrine = new DoctrineStore(new Database(":memory:"), dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function app() {
    const retrieval = {
      purge: vi.fn(async () => {}),
      ingest: vi.fn(async () => 1),
      query: vi.fn(async () => []),
    };
    const a = express();
    a.use(express.json());
    a.use(createRagRouter(retrieval as any, doctrine, console as any));
    return { app: a, retrieval };
  }

  it("rejects doctrine delete for traversal paths", async () => {
    const { app: a, retrieval } = app();
    const res = await request(a).delete("/doctrine/..%2F..%2Fetc%2Fevil.md");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(retrieval.purge).not.toHaveBeenCalled();
  });

  it("deletes a safe nested doctrine source", async () => {
    doctrine.saveFile("intel/note.md", "# note");
    const { app: a, retrieval } = app();
    const res = await request(a).delete("/doctrine/intel%2Fnote.md");
    expect(res.status).toBe(200);
    expect(retrieval.purge).toHaveBeenCalledWith("intel/note.md");
  });

  it("POST /doctrine/reindex accepts selective sources", async () => {
    doctrine.saveFile("a.md", "# a");
    doctrine.saveFile("b.md", "# b");
    const { app: a, retrieval } = app();
    const res = await request(a)
      .post("/doctrine/reindex")
      .send({ sources: ["b.md"] });
    expect(res.status).toBe(200);
    expect(res.body.selective).toBe(true);
    expect(res.body.reindexed).toBe(1);
    expect(retrieval.ingest).toHaveBeenCalledTimes(1);
  });

  it("GET /doctrine/export/capabilities reports pandoc availability", async () => {
    vi.spyOn(exportMod, "isPandocAvailable").mockResolvedValue(true);
    const { app: a } = app();
    const res = await request(a).get("/doctrine/export/capabilities");
    expect(res.status).toBe(200);
    expect(res.body.pandoc).toBe(true);
    expect(res.body.formats).toEqual(["docx", "pdf"]);
  });

  it("GET /doctrine/:source/export returns docx attachment", async () => {
    doctrine.saveFile(
      "reports/aar-2026-06-21.md",
      "---\nclassification: unclassified\n---\n\n# AAR",
    );
    vi.spyOn(exportMod, "exportMarkdown").mockResolvedValue(Buffer.from("PK"));
    const { app: a } = app();
    const res = await request(a).get("/doctrine/reports%2Faar-2026-06-21.md/export?format=docx");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("wordprocessingml");
    expect(res.headers["content-disposition"]).toContain("aar-2026-06-21.docx");
    expect(exportMod.exportMarkdown).toHaveBeenCalledWith(expect.stringContaining("# AAR"), "docx");
  });

  it("GET /doctrine/:source/export returns 503 when pandoc is missing", async () => {
    doctrine.saveFile("note.md", "# Note");
    vi.spyOn(exportMod, "exportMarkdown").mockRejectedValue(
      new exportMod.ExportError("PANDOC_UNAVAILABLE", "pandoc is not installed or not on PATH"),
    );
    const { app: a } = app();
    const res = await request(a).get("/doctrine/note.md/export");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("PANDOC_UNAVAILABLE");
  });

  it("GET /doctrine/:source returns file content", async () => {
    doctrine.saveFile("intel/note.md", "classification: secret\n\n# Note");
    doctrine.upsert({
      source: "intel/note.md",
      classification: "secret",
      tags: ["intel"],
      chunks: 2,
      bytes: 30,
      updatedAt: Date.now(),
    });
    const { app: a } = app();
    const res = await request(a).get("/doctrine/intel%2Fnote.md");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("intel/note.md");
    expect(res.body.content).toContain("# Note");
    expect(res.body.meta.classification).toBe("secret");
  });

  it("GET /doctrine/:source rejects traversal paths", async () => {
    const { app: a } = app();
    const res = await request(a).get("/doctrine/..%2Fevil.md");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("PUT /doctrine/:source saves and re-ingests", async () => {
    doctrine.saveFile("brief.md", "# old");
    const { app: a, retrieval } = app();
    const res = await request(a)
      .put("/doctrine/brief.md")
      .send({ content: "classification: confidential\n\n# Updated brief" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ingested.source).toBe("brief.md");
    expect(retrieval.ingest).toHaveBeenCalled();
    expect(doctrine.readFile("brief.md")).toContain("# Updated brief");
  });

  it("PUT /doctrine/:source rejects empty content", async () => {
    const { app: a, retrieval } = app();
    const res = await request(a).put("/doctrine/brief.md").send({ content: "   " });
    expect(res.status).toBe(400);
    expect(retrieval.ingest).not.toHaveBeenCalled();
  });

  it("POST /doctrine/new creates a doc with default template", async () => {
    const { app: a, retrieval } = app();
    const res = await request(a).post("/doctrine/new").send({ source: "intel/intsum" });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe("intel/intsum.md");
    expect(res.body.content).toContain("# Title");
    expect(res.body.ingested.source).toBe("intel/intsum.md");
    expect(retrieval.ingest).toHaveBeenCalled();
    expect(doctrine.readFile("intel/intsum.md")).toContain("classification: unclassified");
  });

  it("POST /doctrine/new rejects duplicate sources", async () => {
    doctrine.saveFile("brief.md", "# existing");
    const { app: a, retrieval } = app();
    const res = await request(a).post("/doctrine/new").send({ source: "brief.md" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
    expect(retrieval.ingest).not.toHaveBeenCalled();
  });
});
