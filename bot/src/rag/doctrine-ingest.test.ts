import { describe, it, expect, vi } from "vitest";
import {
  reindexDoctrine,
  reindexDoctrineSources,
  ingestDoctrineDoc,
  purgeOrphanedDoctrine,
} from "./doctrine-ingest.js";

function bodyFor(source: string): string {
  return `# ${source}\nbody`;
}

function fakes(filesOnDisk: string[], registry: Array<{ source: string; bytes?: number }>) {
  const retrieval = { ingest: vi.fn().mockResolvedValue(2), purge: vi.fn().mockResolvedValue(undefined) };
  const doctrine = {
    dir: "/tmp/doctrine",
    safeName: vi.fn((name: string) => name),
    files: vi.fn(() => filesOnDisk),
    list: vi.fn(() =>
      registry.map((r) => ({
        source: r.source,
        classification: "unclassified",
        tags: [],
        chunks: 1,
        bytes: r.bytes ?? 1,
        updatedAt: 1,
      })),
    ),
    get: vi.fn((source: string) => {
      const row = registry.find((r) => r.source === source);
      if (!row) return null;
      return {
        source: row.source,
        classification: "unclassified",
        tags: [],
        chunks: 1,
        bytes: row.bytes ?? 1,
        updatedAt: 1,
      };
    }),
    readFile: vi.fn((s: string) => (filesOnDisk.includes(s) ? bodyFor(s) : null)),
    saveFile: vi.fn((name: string) => name),
    upsert: vi.fn(),
    remove: vi.fn(() => true),
  };
  return { retrieval: retrieval as any, doctrine: doctrine as any };
}

describe("ingestDoctrineDoc", () => {
  it("parses frontmatter → ingests body with classification + records the registry", async () => {
    const { retrieval, doctrine } = fakes([], []);
    const out = await ingestDoctrineDoc(retrieval, doctrine, "intsum.md", "---\nclassification: secret\ntags: [intel]\n---\n# INTSUM\nbody");
    expect(out).toMatchObject({ source: "intsum.md", classification: "secret", chunks: 2 });
    const [src, body, meta] = retrieval.ingest.mock.calls[0];
    expect(src).toBe("intsum.md");
    expect(body).toContain("# INTSUM");
    expect(meta).toEqual({ classification: "secret", tags: ["intel"] });
  });
});

describe("reindexDoctrine — full sync", () => {
  it("ingests on-disk files and purges docs whose file is gone", async () => {
    const { retrieval, doctrine } = fakes(["a.md", "b.md"], [{ source: "a.md" }, { source: "c.md" }]);
    const out = await reindexDoctrine(retrieval, doctrine);
    expect(retrieval.purge).toHaveBeenCalledWith("c.md");
    expect(doctrine.remove).toHaveBeenCalledWith("c.md");
    expect(out.map((d) => d.source).sort()).toEqual(["a.md", "b.md"]);
    expect(retrieval.ingest).toHaveBeenCalledTimes(2);
  });

  it("re-ingests when classification metadata changes but bytes are unchanged", async () => {
    const content = "---\nclassification: secret\n---\n# body";
    const bytes = Buffer.byteLength(content);
    const { retrieval, doctrine } = fakes(["a.md"], [{ source: "a.md", bytes }]);
    doctrine.readFile.mockReturnValue(content);
    doctrine.get.mockReturnValue({
      source: "a.md",
      classification: "unclassified",
      tags: [],
      chunks: 1,
      bytes,
      updatedAt: 1,
    });
    const out = await reindexDoctrine(retrieval, doctrine);
    expect(out.map((d) => d.source)).toEqual(["a.md"]);
    expect(retrieval.ingest).toHaveBeenCalledTimes(1);
  });

  it("skips byte-identical files during full reindex", async () => {
    const unchanged = Buffer.byteLength(bodyFor("a.md"));
    const { retrieval, doctrine } = fakes(["a.md", "b.md"], [
      { source: "a.md", bytes: unchanged },
      { source: "b.md", bytes: 1 },
    ]);
    const out = await reindexDoctrine(retrieval, doctrine);
    expect(out.map((d) => d.source)).toEqual(["b.md"]);
    expect(retrieval.ingest).toHaveBeenCalledTimes(1);
  });

  it("reindexes nested paths from git-style directory layout", async () => {
    const { retrieval, doctrine } = fakes(["intel/a.md", "ops/b.md"], [{ source: "intel/a.md" }]);
    const out = await reindexDoctrine(retrieval, doctrine);
    expect(out.map((d) => d.source).sort()).toEqual(["intel/a.md", "ops/b.md"]);
  });
});

describe("reindexDoctrineSources — selective", () => {
  it("re-indexes only the requested files", async () => {
    const { retrieval, doctrine } = fakes(["a.md", "b.md", "c.md"], [
      { source: "a.md" },
      { source: "b.md" },
      { source: "c.md" },
    ]);
    const out = await reindexDoctrineSources(retrieval, doctrine, ["b.md"], { force: true });
    expect(out.map((d) => d.source)).toEqual(["b.md"]);
    expect(retrieval.ingest).toHaveBeenCalledTimes(1);
    expect(retrieval.purge).not.toHaveBeenCalled();
  });

  it("purges a listed source when its file was deleted", async () => {
    const { retrieval, doctrine } = fakes(["a.md"], [{ source: "a.md" }, { source: "gone.md" }]);
    const out = await reindexDoctrineSources(retrieval, doctrine, ["gone.md"]);
    expect(out).toEqual([]);
    expect(retrieval.purge).toHaveBeenCalledWith("gone.md");
    expect(doctrine.remove).toHaveBeenCalledWith("gone.md");
  });

  it("skips unchanged files unless force is set", async () => {
    const bytes = Buffer.byteLength(bodyFor("a.md"));
    const { retrieval, doctrine } = fakes(["a.md"], [{ source: "a.md", bytes }]);
    const skipped = await reindexDoctrineSources(retrieval, doctrine, ["a.md"]);
    expect(skipped).toEqual([]);
    expect(retrieval.ingest).not.toHaveBeenCalled();

    const forced = await reindexDoctrineSources(retrieval, doctrine, ["a.md"], { force: true });
    expect(forced.map((d) => d.source)).toEqual(["a.md"]);
    expect(retrieval.ingest).toHaveBeenCalledTimes(1);
  });
});

describe("purgeOrphanedDoctrine", () => {
  it("removes registry + vector chunks for files no longer on disk", async () => {
    const { retrieval, doctrine } = fakes(["a.md"], [{ source: "a.md" }, { source: "orphan.md" }]);
    await purgeOrphanedDoctrine(retrieval, doctrine);
    expect(retrieval.purge).toHaveBeenCalledWith("orphan.md");
    expect(doctrine.remove).toHaveBeenCalledWith("orphan.md");
    expect(retrieval.purge).not.toHaveBeenCalledWith("a.md");
  });
});