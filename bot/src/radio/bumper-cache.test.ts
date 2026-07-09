import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BumperCache } from "./bumper-cache.js";

describe("BumperCache", () => {
  let dir: string;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bumper-cache-test-"));
    now = 1_000_000_000;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const make = (opts: Partial<{ maxEntries: number; ttlMs: number }> = {}) =>
    new BumperCache({ db: new Database(":memory:"), cacheDir: dir, now: () => now, ...opts });

  it("put then get roundtrips", () => {
    const cache = make();
    const p = cache.put("h1", Buffer.from("audio"), "wav", { text: "hi", source: "stationId" });
    expect(p).toContain("h1.wav");
    expect(existsSync(p!)).toBe(true);
    const got = cache.get("h1");
    expect(got).toEqual({ path: p, text: "hi", source: "stationId" });
  });

  it("returns null on a miss", () => {
    expect(make().get("nope")).toBeNull();
  });

  it("treats a vanished file as a miss and drops the row", () => {
    const cache = make();
    const p = cache.put("h2", Buffer.from("x"), "wav", { text: "t", source: "s" });
    rmSync(p!, { force: true });
    expect(cache.get("h2")).toBeNull();
    expect(cache.get("h2")).toBeNull();
  });

  it("refuses to cache a non-unclassified floor (§6.5)", () => {
    const cache = make();
    const p = cache.put("h3", Buffer.from("x"), "wav", {
      text: "secret",
      source: "doctrine",
      builtFloor: "secret",
    });
    expect(p).toBeNull();
    expect(cache.get("h3")).toBeNull();
  });

  it("evicts past the LRU cap", () => {
    const cache = make({ maxEntries: 2 });
    cache.put("a", Buffer.from("1"), "wav", { text: "a", source: "s" });
    now++;
    cache.put("b", Buffer.from("2"), "wav", { text: "b", source: "s" });
    now++;
    cache.put("c", Buffer.from("3"), "wav", { text: "c", source: "s" });
    expect(cache.get("a")).toBeNull(); // least-recently-touched, evicted
    expect(cache.get("b")).not.toBeNull();
    expect(cache.get("c")).not.toBeNull();
  });

  it("prunes entries past their TTL", () => {
    const cache = make({ ttlMs: 1000 });
    cache.put("old", Buffer.from("1"), "wav", { text: "o", source: "s" });
    now += 2000;
    cache.put("new", Buffer.from("2"), "wav", { text: "n", source: "s" });
    expect(cache.get("old")).toBeNull();
    expect(cache.get("new")).not.toBeNull();
  });
});
