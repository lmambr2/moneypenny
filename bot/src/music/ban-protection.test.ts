import { describe, expect, it } from "vitest";
import { banProtectedMessage, isBanProtected } from "./playback-blacklist.js";

const PROTECTED = ["Ella Langley"];

/**
 * Shapes taken verbatim from the live library. The artist field is the yt-dlp
 * uploader, so a re-upload files the real artist under someone else's name —
 * matching on `artist` alone would protect one copy and leave the other
 * bannable.
 */
describe("isBanProtected", () => {
  it("protects a track where the artist field is correct", () => {
    expect(
      isBanProtected(
        { name: "Ella Langley - Dandelion (Official Visualizer)", artist: "Ella Langley" },
        PROTECTED,
      ),
    ).toBe(true);
  });

  it("protects a re-upload where the artist is the uploader", () => {
    // "CountryHype - Ella Langley - Choosin' Texas (Lyrics) [i3zRgQZWMLA].mp3"
    expect(
      isBanProtected(
        { name: "Ella Langley - Choosin' Texas (Lyrics)", artist: "CountryHype" },
        PROTECTED,
      ),
    ).toBe(true);
  });

  it("protects when only the artist field carries the name", () => {
    expect(isBanProtected({ name: "Choosin' Texas", artist: "Ella Langley" }, PROTECTED)).toBe(
      true,
    );
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isBanProtected({ name: "ELLA   LANGLEY - Weren't For The Wind" }, PROTECTED)).toBe(true);
    expect(isBanProtected({ name: "x", artist: "ella langley" }, PROTECTED)).toBe(true);
  });

  it("leaves everything else bannable", () => {
    expect(
      isBanProtected(
        { name: "Rick Astley - Never Gonna Give You Up", artist: "Rick Astley" },
        PROTECTED,
      ),
    ).toBe(false);
    expect(isBanProtected({ name: "Dandelion", artist: "Someone Else" }, PROTECTED)).toBe(false);
  });

  it("does nothing when no artists are protected", () => {
    expect(isBanProtected({ name: "Ella Langley - Dandelion" }, [])).toBe(false);
    expect(isBanProtected({ name: "Ella Langley - Dandelion" }, undefined)).toBe(false);
  });

  it("handles missing song fields without throwing", () => {
    expect(isBanProtected(null, PROTECTED)).toBe(false);
    expect(isBanProtected({}, PROTECTED)).toBe(false);
    expect(isBanProtected({ name: null, artist: null }, PROTECTED)).toBe(false);
  });

  it("ignores blank entries in the protected list rather than matching everything", () => {
    // A stray "" would otherwise make every track protected.
    expect(isBanProtected({ name: "Rick Astley" }, ["", "   "])).toBe(false);
  });

  it("names the track in the refusal", () => {
    expect(banProtectedMessage({ name: "Dandelion", artist: "Ella Langley" })).toContain(
      "Dandelion",
    );
  });
});

import Database from "better-sqlite3";
import { PlaybackBlacklist } from "./playback-blacklist.js";

/**
 * Protection lives in PlaybackBlacklist rather than at each caller (AGENTS.md
 * §3, fix at the highest responsible owner). isBlacklisted() is the gate every
 * consumer funnels through — playback resolve, radio seeds, search filters — so
 * enforcing it there covers callers nobody remembers to guard.
 */
describe("PlaybackBlacklist ban protection", () => {
  function make(protectedArtists: string[] = ["Ella Langley"]) {
    return new PlaybackBlacklist({
      db: new Database(":memory:"),
      protectedArtists: () => protectedArtists,
    });
  }
  const ella = {
    trackKey: "sf6eRmInk1s",
    name: "Ella Langley - Dandelion (Official Visualizer)",
    artist: "Ella Langley",
  };
  const reupload = {
    trackKey: "i3zRgQZWMLA",
    name: "Ella Langley - Choosin' Texas (Lyrics)",
    artist: "CountryHype", // uploader, not the artist
  };
  const other = { trackKey: "dQw4w9WgXcQ", name: "Never Gonna Give You Up", artist: "Rick Astley" };

  it("refuses to store a ban for a protected artist", () => {
    const bl = make();
    expect(() => bl.add(ella)).toThrow(/protected/i);
    expect(bl.list()).toHaveLength(0);
  });

  it("refuses a re-upload whose artist field is the uploader", () => {
    const bl = make();
    expect(() => bl.add(reupload)).toThrow(/protected/i);
  });

  it("still bans everyone else", () => {
    const bl = make();
    bl.add(other);
    expect(bl.isBlacklisted(other)).toBe(true);
  });

  // The gap in the first cut: protection blocked NEW bans but left old ones
  // enforcing, so Ella stayed silently unplayable.
  it("ignores a ban that predates the protection", () => {
    const unprotected = new PlaybackBlacklist({ db: new Database(":memory:") });
    unprotected.add(ella);
    expect(unprotected.isBlacklisted(ella)).toBe(true);

    const nowProtected = new PlaybackBlacklist({
      db: (unprotected as unknown as { db: Database.Database }).db,
      protectedArtists: () => ["Ella Langley"],
    });
    expect(nowProtected.isBlacklisted(ella)).toBe(false);
  });

  it("releaseProtected() clears stale rows and leaves other bans alone", () => {
    const bl = new PlaybackBlacklist({ db: new Database(":memory:") });
    bl.add(ella);
    bl.add(other);

    const withProtection = new PlaybackBlacklist({
      db: (bl as unknown as { db: Database.Database }).db,
      protectedArtists: () => ["Ella Langley"],
    });
    const freed = withProtection.releaseProtected();

    expect(freed.length).toBeGreaterThan(0);
    expect(withProtection.isBlacklisted(other)).toBe(true);
    expect(withProtection.list().some((e) => /ella langley/i.test(e.name ?? ""))).toBe(false);
  });

  it("is a no-op when nothing is protected", () => {
    const bl = new PlaybackBlacklist({ db: new Database(":memory:") });
    bl.add(ella);
    expect(bl.releaseProtected()).toEqual([]);
    expect(bl.isBlacklisted(ella)).toBe(true);
  });

  it("picks up a protected artist added at runtime, without a rebuild", () => {
    const list: string[] = [];
    const bl = new PlaybackBlacklist({
      db: new Database(":memory:"),
      protectedArtists: () => list,
    });
    bl.add(ella);
    expect(bl.isBlacklisted(ella)).toBe(true);
    list.push("Ella Langley"); // settings change
    expect(bl.isBlacklisted(ella)).toBe(false);
  });
});
