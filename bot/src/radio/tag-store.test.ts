import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { TagStore } from "./tag-store.js";

describe("TagStore", () => {
  let store: TagStore;
  beforeEach(() => (store = new TagStore({ db: new Database(":memory:") })));

  it("upserts and reads back tags", () => {
    store.upsert("k1", { genre: "synthwave", bpm: 120 }, "embedded");
    expect(store.get("k1")).toMatchObject({ genre: "synthwave", bpm: 120, source: "embedded" });
  });

  describe("source precedence (manual > analyzer > embedded)", () => {
    it("a higher-precedence source overwrites; analyzer refines embedded BPM/key", () => {
      store.upsert("k", { genre: "ambient", bpm: 90 }, "embedded");
      store.upsert("k", { bpm: 92, musicalKey: "8A" }, "analyzer");
      expect(store.get("k")).toMatchObject({ genre: "ambient", bpm: 92, musicalKey: "8A", source: "analyzer" });
    });

    it("a lower-precedence re-index fills gaps but never clobbers", () => {
      store.upsert("k", { bpm: 128 }, "manual");
      store.upsert("k", { bpm: 130, genre: "techno" }, "embedded"); // re-index
      const t = store.get("k")!;
      expect(t.bpm).toBe(128); // manual value protected
      expect(t.genre).toBe("techno"); // empty field filled
      expect(t.source).toBe("manual");
    });
  });

  describe("bumper flag", () => {
    it("flags, reads, and lists bumper-eligible tracks", () => {
      store.setBumper("jingle", { bumper: true, bumperKind: "id" });
      expect(store.isBumper("jingle")).toBe(true);
      expect(store.bumperKeys()).toEqual(["jingle"]);
      expect(store.bumperKeySet().has("jingle")).toBe(true);
    });

    it("filters by ops scope (null scope matches every profile)", () => {
      store.setBumper("mining-id", { bumper: true, opsScope: "mining,combat" });
      store.setBumper("any-id", { bumper: true }); // no scope → matches all
      expect(store.bumperKeys("mining").sort()).toEqual(["any-id", "mining-id"]);
      expect(store.bumperKeys("hauling")).toEqual(["any-id"]);
    });

    it("does not disturb tag source (analyzer can still write after flagging)", () => {
      store.upsert("k", { genre: "ambient" }, "embedded");
      store.setBumper("k", { bumper: true });
      store.upsert("k", { bpm: 100 }, "analyzer");
      expect(store.get("k")).toMatchObject({ bumper: true, bpm: 100, source: "analyzer" });
    });
  });
});
