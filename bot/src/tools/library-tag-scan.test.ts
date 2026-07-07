import { describe, it, expect } from "vitest";
import { verdictForTally, type TagScanTally } from "./library-tag-scan.js";

function tally(overrides: Partial<TagScanTally>): TagScanTally {
  return {
    total: 0,
    parsed: 0,
    failed: 0,
    genre: 0,
    bpm: 0,
    key: 0,
    mood: 0,
    subgenre: 0,
    genreHist: new Map(),
    ...overrides,
  };
}

describe("library-tag-scan verdict", () => {
  it("reports empty corpus", () => {
    expect(verdictForTally(tally({ parsed: 0 }))).toMatch(/no parsable audio/);
  });

  it("defers analyzer when key and bpm are high", () => {
    expect(
      verdictForTally(tally({ parsed: 100, key: 70, bpm: 65, genre: 10 })),
    ).toMatch(/HIGH/);
  });

  it("recommends keyfinder when genre-rich but key/bpm sparse", () => {
    expect(
      verdictForTally(tally({ parsed: 100, key: 5, bpm: 4, genre: 80 })),
    ).toMatch(/keyfinder\+aubio/);
  });

  it("recommends full analyzer when coverage is sparse", () => {
    expect(
      verdictForTally(tally({ parsed: 100, key: 5, bpm: 4, genre: 20 })),
    ).toMatch(/SPARSE/);
  });
});