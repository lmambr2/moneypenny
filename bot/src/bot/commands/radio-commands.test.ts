import { describe, expect, it } from "vitest";
import type { Song } from "../../music/provider.js";
import {
  externalSeedQuery,
  isRadioSeedFriendlySong,
  mixLocalAndExternalSeeds,
  normalizeSeedSources,
  orderSeedCandidates,
  parseTagFilters,
  RADIO_SEED_MAX_DURATION_SEC,
  shuffleSongs,
} from "./radio-commands.js";

function seed(over: Partial<Song> = {}): Song {
  return {
    id: over.id ?? "s1",
    name: over.name ?? "Ordinary Song",
    artist: over.artist ?? "Some Artist",
    album: over.album ?? "Some Album",
    platform: over.platform ?? "local",
    coverUrl: over.coverUrl ?? "",
    duration: over.duration ?? 210,
  } as Song;
}

/** Deterministic rng so shuffle-dependent assertions are stable. */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe("isRadioSeedFriendlySong", () => {
  it("accepts an ordinary track", () => {
    expect(isRadioSeedFriendlySong(seed())).toBe(true);
  });

  it("accepts a track with unknown duration", () => {
    expect(isRadioSeedFriendlySong(seed({ duration: 0 }))).toBe(true);
  });

  // Length no longer disqualifies: auto-DJ airs a bounded window of a long mix
  // (radio/mix-window.ts), so an hour-long upload costs one queue slot, not an
  // hour of the station. Callers wanting whole tracks pass allowLongMixes=false.
  it("admits over-long tracks so they can be windowed", () => {
    expect(isRadioSeedFriendlySong(seed({ duration: RADIO_SEED_MAX_DURATION_SEC + 1 }))).toBe(true);
    expect(isRadioSeedFriendlySong(seed({ duration: 3 * 60 * 60 }))).toBe(true);
    expect(isRadioSeedFriendlySong(seed({ duration: RADIO_SEED_MAX_DURATION_SEC }))).toBe(true);
  });

  it("still enforces the cap when long mixes are disallowed", () => {
    const overCap = seed({ duration: RADIO_SEED_MAX_DURATION_SEC + 1 });
    expect(isRadioSeedFriendlySong(overCap, RADIO_SEED_MAX_DURATION_SEC, null, null, false)).toBe(
      false,
    );
    const atCap = seed({ duration: RADIO_SEED_MAX_DURATION_SEC });
    expect(isRadioSeedFriendlySong(atCap, RADIO_SEED_MAX_DURATION_SEC, null, null, false)).toBe(
      true,
    );
  });

  // Multi-hour mixes hog the channel; these titles are rejected on text even
  // when duration metadata is missing.
  it.each([
    "Chillhop 3 hours of study beats",
    "Pink Floyd Full Album",
    "2 Hour Ambient",
    "Deep house mix for working",
  ])("rejects mega-mix title %o", (name) => {
    expect(isRadioSeedFriendlySong(seed({ name, duration: 0 }))).toBe(false);
  });

  it("rejects a long 'vol. N' compilation but allows a short one", () => {
    expect(isRadioSeedFriendlySong(seed({ name: "Jazz Classics Vol. 3", duration: 0 }))).toBe(
      false,
    );
    expect(isRadioSeedFriendlySong(seed({ name: "Jazz Classics Vol. 3", duration: 240 }))).toBe(
      true,
    );
  });

  it("honors the blocked-genre policy", () => {
    const song = seed({ name: "Some Rap Track", album: "Rap" });
    expect(isRadioSeedFriendlySong(song, RADIO_SEED_MAX_DURATION_SEC, [])).toBe(true);
    expect(isRadioSeedFriendlySong(song, RADIO_SEED_MAX_DURATION_SEC, ["rap"])).toBe(false);
  });

  it("honors the admin playback blacklist", () => {
    const banned = { isBlacklisted: (s: { id: string }) => s.id === "bad" };
    expect(isRadioSeedFriendlySong(seed({ id: "bad" }), undefined, null, banned as never)).toBe(
      false,
    );
    expect(isRadioSeedFriendlySong(seed({ id: "ok" }), undefined, null, banned as never)).toBe(
      true,
    );
  });
});

describe("shuffleSongs", () => {
  it("returns a new array and leaves the input untouched", () => {
    const input = [1, 2, 3, 4];
    const out = shuffleSongs(input, seqRng([0]));
    expect(out).not.toBe(input);
    expect(input).toEqual([1, 2, 3, 4]);
  });

  it("preserves every element", () => {
    const input = ["a", "b", "c", "d", "e"];
    const out = shuffleSongs(input, seqRng([0.1, 0.9, 0.4, 0.7]));
    expect([...out].sort()).toEqual([...input].sort());
  });

  it("handles empty and single-item lists", () => {
    expect(shuffleSongs([])).toEqual([]);
    expect(shuffleSongs(["only"])).toEqual(["only"]);
  });
});

describe("orderSeedCandidates", () => {
  const items = (...ids: string[]) => ids.map((id) => ({ id }));

  // The point of the ordering: recently played tracks go last so auto-DJ
  // cannot lock onto one hit forever.
  it("demotes recently played ids behind fresh ones", () => {
    const out = orderSeedCandidates(items("a", "b", "c", "d"), ["a", "b"], { shuffle: false });
    expect(out.map((x) => x.id)).toEqual(["c", "d", "a", "b"]);
  });

  it("keeps every candidate when none are recent", () => {
    const out = orderSeedCandidates(items("a", "b"), [], { shuffle: false });
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("still returns recents when everything is stale", () => {
    const out = orderSeedCandidates(items("a", "b"), ["a", "b"], { shuffle: false });
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("applies the cap", () => {
    const out = orderSeedCandidates(items("a", "b", "c", "d"), [], { cap: 2, shuffle: false });
    expect(out).toHaveLength(2);
  });

  it("never returns an empty pool for a zero or negative cap", () => {
    expect(orderSeedCandidates(items("a", "b"), [], { cap: 0, shuffle: false })).toHaveLength(1);
  });
});

describe("mixLocalAndExternalSeeds", () => {
  const local = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `L${i}`, platform: "local" }));
  const ext = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `Y${i}`, platform: "youtube" }));
  const noShuffle = { shuffle: false as const };

  // An explicit 0 or 1 is a hard constraint, not a target — the excluded side
  // must never appear even when the preferred side is thin.
  it("ratio 0 yields local only, with no external backfill", () => {
    const out = mixLocalAndExternalSeeds(local(2), ext(20), {
      ...noShuffle,
      externalRatio: 0,
      cap: 10,
    });
    expect(out.every((s) => s.platform === "local")).toBe(true);
    expect(out).toHaveLength(2);
  });

  it("ratio 1 yields external only, with no local backfill", () => {
    const out = mixLocalAndExternalSeeds(local(20), ext(2), {
      ...noShuffle,
      externalRatio: 1,
      cap: 10,
    });
    expect(out.every((s) => s.platform === "youtube")).toBe(true);
    expect(out).toHaveLength(2);
  });

  it("falls back entirely to the other side when one is empty", () => {
    expect(
      mixLocalAndExternalSeeds(local(0), ext(5), { ...noShuffle, externalRatio: 0.5, cap: 5 }),
    ).toHaveLength(5);
    expect(
      mixLocalAndExternalSeeds(local(5), ext(0), { ...noShuffle, externalRatio: 0.5, cap: 5 }),
    ).toHaveLength(5);
  });

  it("mixes both sides toward the ratio when both are plentiful", () => {
    const out = mixLocalAndExternalSeeds(local(20), ext(20), {
      ...noShuffle,
      externalRatio: 0.5,
      cap: 10,
    });
    expect(out).toHaveLength(10);
    const externals = out.filter((s) => s.platform === "youtube").length;
    expect(externals).toBeGreaterThan(0);
    expect(externals).toBeLessThan(10);
  });

  // A thin local library must not starve the pool.
  it("backfills from external when the library is thin", () => {
    const out = mixLocalAndExternalSeeds(local(1), ext(20), {
      ...noShuffle,
      externalRatio: 0.5,
      cap: 10,
    });
    expect(out).toHaveLength(10);
    expect(out.filter((s) => s.platform === "local")).toHaveLength(1);
  });

  it("never exceeds the cap", () => {
    const out = mixLocalAndExternalSeeds(local(50), ext(50), {
      ...noShuffle,
      externalRatio: 0.66,
      cap: 7,
    });
    expect(out).toHaveLength(7);
  });

  it("returns no duplicates", () => {
    const out = mixLocalAndExternalSeeds(local(10), ext(10), {
      ...noShuffle,
      externalRatio: 0.5,
      cap: 12,
    });
    expect(new Set(out.map((s) => s.id)).size).toBe(out.length);
  });
});

describe("normalizeSeedSources", () => {
  it("passes through valid sources and de-duplicates", () => {
    expect(normalizeSeedSources(["local", "youtube", "local"])).toEqual(["local", "youtube"]);
  });

  it("drops unknown sources", () => {
    expect(normalizeSeedSources(["local", "netease", "qq"] as string[])).toEqual(["local"]);
  });

  it("falls back to defaults for empty, all-invalid, or missing input", () => {
    const dflt = normalizeSeedSources(null);
    expect(dflt.length).toBeGreaterThan(0);
    expect(normalizeSeedSources([])).toEqual(dflt);
    expect(normalizeSeedSources(["nope"] as string[])).toEqual(dflt);
    expect(normalizeSeedSources(undefined)).toEqual(dflt);
  });
});

describe("parseTagFilters", () => {
  it("keeps only string entries in list filters", () => {
    const out = parseTagFilters({ mood: ["calm", 42, null, "dark"] });
    expect(out.mood).toEqual(["calm", "dark"]);
  });

  it("coerces numeric filters and drops non-numeric ones", () => {
    const out = parseTagFilters({ bpmMin: "90", bpmMax: "abc", energyMin: 0.4 });
    expect(out.bpmMin).toBe(90);
    expect(out.bpmMax).toBeUndefined();
    expect(out.energyMin).toBe(0.4);
  });

  it("ignores non-array list filters and non-string keys", () => {
    const out = parseTagFilters({ genreAny: "rock", musicalKey: 5 });
    expect(out.genreAny).toBeUndefined();
    expect(out.musicalKey).toBeUndefined();
  });

  it("returns all-undefined for an empty filter object", () => {
    const out = parseTagFilters({});
    expect(Object.values(out).every((v) => v === undefined)).toBe(true);
  });
});

/**
 * Auto-DJ repeated the same ~40 tracks because the external half of every seed
 * pool came back empty: profile seeds are genre phrases, and YouTube's top hits
 * for a bare genre phrase are 1-3 hour compilations that isRadioSeedFriendlySong
 * rejects at the 15-minute cap. Measured on the live seven seeds, 5/84 results
 * survived bare vs 51/84 with the suffix.
 */
describe("externalSeedQuery", () => {
  it("biases a bare genre seed toward single tracks", () => {
    expect(externalSeedQuery("classic rock")).toBe("classic rock official audio");
    expect(externalSeedQuery("yacht rock")).toBe("yacht rock official audio");
  });

  it("trims surrounding whitespace", () => {
    expect(externalSeedQuery("  hard rock  ")).toBe("hard rock official audio");
  });

  it("is idempotent — never doubles the suffix", () => {
    const once = externalSeedQuery("soft rock");
    expect(externalSeedQuery(once)).toBe(once);
  });

  it("leaves seeds that already request a specific upload alone", () => {
    expect(externalSeedQuery("Toto - Africa (Official Video)")).toBe(
      "Toto - Africa (Official Video)",
    );
    expect(externalSeedQuery("Lido Shuffle - Full Version")).toBe("Lido Shuffle - Full Version");
    expect(externalSeedQuery("Boz Scaggs lyrics")).toBe("Boz Scaggs lyrics");
  });

  it("never rewrites a URL seed — those go to the stream bridge verbatim", () => {
    const spotify = "https://open.spotify.com/track/abc123";
    expect(externalSeedQuery(spotify)).toBe(spotify);
    expect(externalSeedQuery("tidal://track/42")).toBe("tidal://track/42");
    expect(externalSeedQuery("http://icecast.example/stream.mp3")).toBe(
      "http://icecast.example/stream.mp3",
    );
  });

  it("passes an empty seed through untouched", () => {
    expect(externalSeedQuery("")).toBe("");
    expect(externalSeedQuery("   ")).toBe("");
  });

  it("honours a caller-supplied suffix", () => {
    expect(externalSeedQuery("pop rock", "topic")).toBe("pop rock topic");
  });
});
