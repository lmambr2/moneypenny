import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DoctrineStore } from "../../data/doctrine.js";
import { createRagRouter } from "./rag.js";

describe("GET /doctrine/hygiene (R2)", () => {
  let dir: string;
  let doctrine: DoctrineStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rag-hyg-"));
    doctrine = new DoctrineStore(new Database(":memory:"), dir);
    doctrine.upsert({
      source: "combat.md",
      classification: "restricted",
      tags: ["fleet"],
      chunks: 3,
      bytes: 100,
      validUntil: "2099-01-01",
      updatedAt: Date.now(),
    });
    doctrine.upsert({
      source: "old.md",
      classification: "unclassified",
      tags: [],
      chunks: 1,
      bytes: 10,
      validUntil: "2020-01-01",
      updatedAt: Date.now(),
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns classification summary and expired count", async () => {
    const retrieval = {
      purge: vi.fn(),
      ingest: vi.fn(),
      query: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use(createRagRouter(retrieval as any, doctrine, console as any));

    const res = await request(app).get("/doctrine/hygiene");
    expect(res.status).toBe(200);
    expect(res.body.docCount).toBe(2);
    expect(res.body.byClassification.restricted).toBe(1);
    expect(res.body.byClassification.unclassified).toBe(1);
    expect(res.body.expiredCount).toBe(1);
    expect(res.body.reindex.endpoint).toMatch(/reindex/);
    expect(res.body.docs.some((d: { source: string }) => d.source === "combat.md")).toBe(true);
  });
});
