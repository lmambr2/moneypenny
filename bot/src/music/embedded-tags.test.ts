import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { TagStore } from "../radio/tag-store.js";
import { parseKeyScale, tagsFromEmbeddedCommon } from "./embedded-tags.js";

describe("tagsFromEmbeddedCommon", () => {
  it("maps genre bpm key mood", () => {
    expect(
      tagsFromEmbeddedCommon({
        genre: [" Synthwave "],
        bpm: 118.4,
        key: "Am",
        mood: "energetic",
      }),
    ).toEqual({
      genre: "Synthwave",
      bpm: 118,
      musicalKey: "A",
      keyScale: "minor",
      mood: "energetic",
    });
  });

  it("returns empty when nothing useful", () => {
    expect(tagsFromEmbeddedCommon({})).toEqual({});
    expect(tagsFromEmbeddedCommon(null)).toEqual({});
  });
});

describe("parseKeyScale", () => {
  it("parses major and sharp roots", () => {
    expect(parseKeyScale("F# major")).toEqual({ musicalKey: "F#", keyScale: "major" });
    expect(parseKeyScale("Bb")).toEqual({ musicalKey: "Bb" });
  });
});

describe("embedded seed via TagStore precedence", () => {
  it("writes source embedded and does not clobber manual", () => {
    const store = new TagStore({ db: new Database(":memory:") });
    const tags = tagsFromEmbeddedCommon({ genre: ["ambient"], bpm: 90 });
    store.upsert("t1", tags, "embedded");
    expect(store.get("t1")).toMatchObject({ genre: "ambient", bpm: 90, source: "embedded" });

    store.upsert("t1", { genre: "manual-genre", mood: "calm" }, "manual");
    // Re-seed from embedded must not wipe manual genre
    store.upsert("t1", tagsFromEmbeddedCommon({ genre: ["id3-genre"], bpm: 100 }), "embedded");
    const row = store.get("t1")!;
    expect(row.genre).toBe("manual-genre");
    expect(row.mood).toBe("calm");
    // empty bpm field can be filled by lower source when missing? precedence:
    // manual source rank 3, embedded 1 — so embedded cannot overwrite present fields
    expect(row.bpm).toBe(90); // was set with embedded first; manual didn't touch bpm
    // New field from embedded when already manual source: incoming rank < existing → only fill empty
    store.upsert("t1", { energy: 0.5 }, "embedded");
    expect(store.get("t1")!.energy).toBe(0.5);
  });
});
