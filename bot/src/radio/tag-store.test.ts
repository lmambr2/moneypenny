import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
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
      expect(store.get("k")).toMatchObject({
        genre: "ambient",
        bpm: 92,
        musicalKey: "8A",
        source: "analyzer",
      });
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

  describe("selectTracks (§9.4)", () => {
    it("filters by tags, case-insensitively, and always excludes bumpers", () => {
      store.upsert("calm1", { mood: "Calm", genre: "Ambient", bpm: 90 }, "analyzer");
      store.upsert("calm2", { mood: "calm", genre: "synthwave", bpm: 105 }, "analyzer");
      store.upsert("hype", { mood: "hype", genre: "dnb", bpm: 174 }, "analyzer");
      store.upsert("jingle", { mood: "calm", genre: "ambient" }, "manual");
      store.setBumper("jingle", { bumper: true });

      const keys = store.selectTracks({ mood: ["calm"], bpmMax: 110 });
      expect(keys.sort()).toEqual(["calm1", "calm2"]);
      expect(store.selectTracks({ genreAny: ["AMBIENT"] })).toEqual(["calm1"]);
    });

    it("ratingMin thresholds the smoothed score, and limit caps", () => {
      for (const k of ["a", "b", "c"]) store.upsert(k, { genre: "ambient" }, "analyzer");
      for (let i = 0; i < 10; i++) store.rate("a", `ts:a${i}`, 5); // strong favourite
      for (let i = 0; i < 10; i++) store.rate("c", `ts:c${i}`, 1); // strong dud (keeps the global mean moderate)
      store.rate("b", "ts:x", 5); // lone 5-star — damped toward the ~3.1 mean, below 4

      expect(store.selectTracks({ genreAny: ["ambient"], ratingMin: 4 })).toEqual(["a"]);
      expect(store.selectTracks({ genreAny: ["ambient"], limit: 2 })).toHaveLength(2);
    });
  });

  describe("ratings (§9.7)", () => {
    it("aggregates per-rater stars, one row per rater (upsert)", () => {
      store.rate("t", "ts:alice", 4);
      store.rate("t", "ts:bob", 2);
      expect(store.getRating("t")).toEqual({ avg: 3, count: 2 });
      store.rate("t", "ts:alice", 5); // re-rate, not a new row
      expect(store.getRating("t")).toEqual({ avg: 3.5, count: 2 });
    });

    it("unrate removes a rating and updates the aggregate", () => {
      store.rate("t", "ts:alice", 5);
      store.rate("t", "ts:bob", 3);
      expect(store.unrate("t", "ts:alice")).toBe(true);
      expect(store.getRating("t")).toEqual({ avg: 3, count: 1 });
      expect(store.unrate("t", "ts:nobody")).toBe(false);
    });

    it("rejects out-of-range stars (trust boundary)", () => {
      expect(() => store.rate("t", "ts:a", 0)).toThrow();
      expect(() => store.rate("t", "ts:a", 6)).toThrow();
    });

    it("Bayesian smoothing: a well-rated track outranks a lone 5-star", () => {
      for (let i = 0; i < 10; i++) store.rate("hits", `ts:${i}`, 5);
      store.rate("one", "ts:x", 5);
      for (let i = 0; i < 5; i++) store.rate("low", `ts:l${i}`, 1);
      expect(store.smoothedScore("hits")).toBeGreaterThan(store.smoothedScore("one"));
      expect(store.smoothedScore("one")).toBeLessThan(5); // damped toward the mean
    });

    it("unrated tracks score at the global mean", () => {
      store.rate("a", "ts:x", 4);
      store.rate("b", "ts:y", 2);
      expect(store.smoothedScore("never-rated")).toBe(3); // (4+2)/2
    });
  });
});
