import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { FileDropStore } from "./file-drop.js";

describe("FileDropStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("seen() reflects what was recorded; record() is idempotent on the key", () => {
    const store = new FileDropStore(new Database(":memory:"));
    expect(store.seen("k1")).toBe(false);
    store.record({ key: "k1", name: "a.md", kind: "doctrine", result: "2 chunks" });
    expect(store.seen("k1")).toBe(true);
    store.record({ key: "k1", name: "a.md", kind: "doctrine", result: "3 chunks" }); // upsert, no dup
    expect(store.recent().filter((r) => r.key === "k1")).toHaveLength(1);
  });

  it("recent() returns newest-first and respects the limit", () => {
    const store = new FileDropStore(new Database(":memory:"));
    vi.setSystemTime(1000); store.record({ key: "a", name: "a.md", kind: "doctrine", result: "ok" });
    vi.setSystemTime(2000); store.record({ key: "b", name: "b.mp3", kind: "music", result: "added" });
    vi.setSystemTime(3000); store.record({ key: "c", name: "c.txt", kind: "skipped", result: "unsupported type" });

    const recent = store.recent(2);
    expect(recent.map((r) => r.name)).toEqual(["c.txt", "b.mp3"]); // newest first, capped at 2
    expect(recent[0]).toMatchObject({ kind: "skipped", result: "unsupported type", ingestedAt: 3000 });
  });
});
