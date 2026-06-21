import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { DoctrineStore } from "./doctrine.js";

describe("DoctrineStore", () => {
  let store: DoctrineStore;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctrine-"));
    store = new DoctrineStore(new Database(":memory:"), dir);
  });

  it("rejects non-markdown + path traversal; allows safe nested paths", () => {
    expect(store.safeName("../../etc/passwd")).toBeNull();
    expect(store.safeName("../../etc/evil.md")).toBeNull();
    expect(store.safeName("evil.sh")).toBeNull();
    expect(store.safeName("intsum.md")).toBe("intsum.md");
    expect(store.safeName("intel/intsum.md")).toBe("intel/intsum.md");
    expect(store.safeName("a/b/doc.markdown")).toBe("a/b/doc.markdown");
  });

  it("saveFile skips rewrite when content is unchanged (avoids watcher loops)", () => {
    store.saveFile("loop.md", "same body");
    const m1 = statSync(join(store.dir, "loop.md")).mtimeMs;
    store.saveFile("loop.md", "same body");
    expect(statSync(join(store.dir, "loop.md")).mtimeMs).toBe(m1);
  });

  it("saves a file to the doctrine dir and reads it back", () => {
    const source = store.saveFile("intsum.md", "# Intel\nbody");
    expect(source).toBe("intsum.md");
    expect(existsSync(join(store.dir, "intsum.md"))).toBe(true);
    expect(store.readFile("intsum.md")).toBe("# Intel\nbody");
  });

  it("upserts + lists registry metadata", () => {
    store.upsert({ source: "a.md", classification: "secret", tags: ["intel"], chunks: 3, bytes: 100, updatedAt: 1 });
    store.upsert({ source: "a.md", classification: "restricted", tags: ["intel", "ops"], chunks: 5, bytes: 200, updatedAt: 2 });
    const docs = store.list();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ source: "a.md", classification: "restricted", tags: ["intel", "ops"], chunks: 5 });
  });

  it("remove deletes the file + registry row", () => {
    store.saveFile("gone.md", "x");
    store.upsert({ source: "gone.md", classification: "unclassified", tags: [], chunks: 1, bytes: 1, updatedAt: 1 });
    expect(store.remove("gone.md")).toBe(true);
    expect(existsSync(join(dir, "gone.md"))).toBe(false);
    expect(store.get("gone.md")).toBeNull();
  });

  it("files() lists markdown on disk recursively (reindex source of truth)", () => {
    store.saveFile("one.md", "a");
    store.saveFile("two.markdown", "b");
    store.saveFile("intel/intsum.md", "c");
    expect(store.files().sort()).toEqual(["intel/intsum.md", "one.md", "two.markdown"]);
  });
});
