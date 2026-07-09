/**
 * Drives LocalProvider.indexFile → seedEmbeddedTags with injectable music-metadata.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TagStore } from "../radio/tag-store.js";

vi.mock("music-metadata", () => ({
  parseFile: vi.fn(async () => ({
    common: {
      title: "Neon",
      artist: "Cats",
      album: "Night",
      genre: ["synthwave"],
      bpm: 118,
      key: "Am",
      picture: undefined,
    },
    format: { duration: 42 },
  })),
}));

// Import after mock
import { LocalProvider } from "./local.js";

describe("LocalProvider embedded seed on index", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mp-embed-idx-"));
    await fs.writeFile(path.join(tmpDir, "song.mp3"), "bytes");
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("upserts source=embedded tags from parsed metadata", async () => {
    const store = new TagStore({ db: new Database(":memory:") });
    const provider = new LocalProvider({ musicDir: tmpDir, tagStore: store });
    const songs = await provider.search("");
    expect(songs.songs.length).toBe(1);
    const id = songs.songs[0]!.id;
    const tags = store.get(id);
    expect(tags).toMatchObject({
      genre: "synthwave",
      bpm: 118,
      musicalKey: "A",
      keyScale: "minor",
      source: "embedded",
    });
  });

  it("does not clobber manual tags on re-index", async () => {
    const store = new TagStore({ db: new Database(":memory:") });
    const provider = new LocalProvider({ musicDir: tmpDir, tagStore: store });
    const songs = await provider.search("");
    const id = songs.songs[0]!.id;
    store.upsert(id, { genre: "manual-rock", mood: "dark" }, "manual");
    await provider.refresh();
    const tags = store.get(id)!;
    expect(tags.genre).toBe("manual-rock");
    expect(tags.mood).toBe("dark");
    // embedded may still fill empty fields only — bpm was from first seed under manual source
    // After manual upsert, source is manual; re-seed with embedded cannot overwrite genre
    expect(tags.source).toBe("manual");
  });
});
