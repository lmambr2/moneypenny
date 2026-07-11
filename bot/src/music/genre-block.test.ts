import { describe, expect, it } from "vitest";
import {
  DEFAULT_MUSIC_BLOCKED_GENRES,
  filterUnblockedSongs,
  isBlockedGenreSong,
  normalizeMusicBlockedGenres,
  songGenreHaystack,
  textMatchesBlockedGenre,
} from "./genre-block.js";

describe("normalizeMusicBlockedGenres", () => {
  it("defaults to rap/hip-hop/R&B family when unset", () => {
    expect(normalizeMusicBlockedGenres(undefined)).toEqual([...DEFAULT_MUSIC_BLOCKED_GENRES]);
    expect(normalizeMusicBlockedGenres(null)).toContain("rap");
    expect(normalizeMusicBlockedGenres(null)).toContain("r&b");
  });

  it("empty array means allow all", () => {
    expect(normalizeMusicBlockedGenres([])).toEqual([]);
  });

  it("trims and dedupes", () => {
    expect(normalizeMusicBlockedGenres([" Rap ", "rap", "HIP-HOP"])).toEqual(["rap", "hip-hop"]);
  });
});

describe("textMatchesBlockedGenre", () => {
  const terms = normalizeMusicBlockedGenres(undefined);

  it("blocks rap / hip-hop / r&b labels", () => {
    expect(textMatchesBlockedGenre("best rap songs 2024", terms)).toBe(true);
    expect(textMatchesBlockedGenre("classic hip-hop mix", terms)).toBe(true);
    expect(textMatchesBlockedGenre("smooth r&b vibes", terms)).toBe(true);
    expect(textMatchesBlockedGenre("late night rnb", terms)).toBe(true);
    expect(textMatchesBlockedGenre("rhythm and blues classics", terms)).toBe(true);
  });

  it("allows unrelated genres", () => {
    expect(textMatchesBlockedGenre("yacht rock forever", terms)).toBe(false);
    expect(textMatchesBlockedGenre("toto africa", terms)).toBe(false);
    expect(textMatchesBlockedGenre("synthwave drive", terms)).toBe(false);
  });
});

describe("isBlockedGenreSong / filter", () => {
  it("matches tagged genre even when title is clean", () => {
    expect(
      isBlockedGenreSong({ name: "Smooth Operator", artist: "Sade", genre: "R&B" }, undefined),
    ).toBe(true);
    expect(isBlockedGenreSong({ name: "Africa", artist: "Toto", genre: "rock" }, undefined)).toBe(
      false,
    );
  });

  it("filterUnblockedSongs drops hits", () => {
    const songs = [
      { name: "Africa", artist: "Toto" },
      { name: "Rap God", artist: "Eminem" },
      { name: "Billie Jean", artist: "Michael Jackson", genre: "rnb" },
    ];
    const kept = filterUnblockedSongs(songs, undefined);
    expect(kept.map((s) => s.name)).toEqual(["Africa"]);
  });

  it("explicit empty policy allows all", () => {
    expect(isBlockedGenreSong({ name: "Rap God", artist: "X" }, [])).toBe(false);
  });

  it("haystack joins fields", () => {
    expect(songGenreHaystack({ name: "A", artist: "B", album: "C", genre: "D" })).toContain("d");
  });
});
