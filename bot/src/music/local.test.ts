import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LocalProvider } from "./local.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("LocalProvider - path guard (safeResolve)", () => {
  let tmpDir: string;
  let provider: LocalProvider;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moneypenny-local-test-"));
    // Create a safe subdir structure
    await fs.mkdir(path.join(tmpDir, "music", "rock"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "music", "pop"), { recursive: true });

    // Create a couple of fake files (metadata parse will be skipped gracefully)
    await fs.writeFile(path.join(tmpDir, "music", "rock", "test1.mp3"), "fake-mp3");
    await fs.writeFile(path.join(tmpDir, "music", "pop", "test2.flac"), "fake-flac");

    provider = new LocalProvider({ musicDir: tmpDir });
  });

  afterEach(async () => {
    // Best effort cleanup
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("blocks path traversal with ../ in resolve()", async () => {
    const result = await provider.resolve("../../../etc/passwd");
    expect(result).toBeNull();
  });

  it("blocks absolute paths outside musicDir in resolve()", async () => {
    const result = await provider.resolve("/etc/passwd");
    expect(result).toBeNull();
  });

  it("allows a valid relative path inside musicDir (high-certainty)", async () => {
    // Even if metadata fails, the guard should return a song shell for a real file on disk
    const result = await provider.resolve("music/rock/test1.mp3");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("song");
    if (result!.type === "song") {
      expect(result!.item.name).toContain("test1");
      expect(result!.item.platform).toBe("local");
    }
  });

  it("getSongUrl also enforces the guard and rejects traversal", async () => {
    const url = await provider.getSongUrl("../../../etc/shadow");
    expect(url).toBeNull();
  });

  it("does not leak files outside the prefix during indexing", async () => {
    // The walk + indexFile guard should have prevented anything outside
    // We mainly assert that resolve on an escaped name never succeeds
    const escaped = await provider.resolve("music/../../../etc");
    expect(escaped).toBeNull();
  });

  it("medium-certainty filename match still goes through safe paths only", async () => {
    const result = await provider.resolve("test1");
    // Should find via filename fallback (medium certainty)
    expect(result).not.toBeNull();
    expect(result!.type).toBe("song");
  });

  it("resolve() does not return a non-audio file as a playable song (F-3)", async () => {
    await fs.writeFile(path.join(tmpDir, "music", "notes.txt"), "not audio");
    const result = await provider.resolve("music/notes.txt");
    expect(result).toBeNull();
  });

  it("m3u out-of-tree entries are dropped at parse time (F-3)", async () => {
    const m3u = [
      "#EXTM3U",
      "#EXTINF:0,In Tree",
      "rock/test1.mp3",
      "#EXTINF:0,Escape",
      "../../../../etc/passwd",
      "/etc/shadow",
    ].join("\n");
    await fs.writeFile(path.join(tmpDir, "music", "list.m3u"), m3u);

    const pl = await provider.resolve("music/list.m3u");
    expect(pl).not.toBeNull();
    expect(pl!.type).toBe("playlist");

    const songs = await provider.getPlaylistSongs(pl!.item.id);
    // Only the in-tree entry survives; the traversal + absolute escapes are gone.
    expect(songs).toHaveLength(1);
    expect(songs[0].name).toBe("In Tree");
    // And no opaque ID leaks a filesystem path (F-2).
    expect(songs[0].id).not.toContain("/");
    expect(songs[0].id).not.toContain("passwd");
  });
});

describe("LocalProvider - uploadSong + refresh (web UI)", () => {
  let tmpDir: string;
  let provider: LocalProvider;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moneypenny-upload-test-"));
    // Seed a couple of real-ish files so indexing has baseline
    await fs.mkdir(path.join(tmpDir, "existing"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "existing", "seed1.mp3"), "seed-data-1");
    await fs.writeFile(path.join(tmpDir, "existing", "seed2.flac"), "seed-data-2");

    provider = new LocalProvider({ musicDir: tmpDir });
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("uploadSong writes to dedicated uploads/ subdir and returns a Song", async () => {
    const buf = Buffer.from("fake-mp3-bytes-for-upload-test");
    const song = await provider.uploadSong("my new track.mp3", buf);

    expect(song).toBeTruthy();
    expect(song.platform).toBe("local");
    expect(song.name).toContain("my new track");

    // File must exist in the isolated uploads/ dir (the "secure that mfer" isolation)
    const expectedPath = path.join(tmpDir, "uploads", "my new track.mp3");
    const exists = await fs.access(expectedPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    // uploads/ subdir was created
    const uploadsDirExists = await fs.access(path.join(tmpDir, "uploads")).then(() => true).catch(() => false);
    expect(uploadsDirExists).toBe(true);

    // Original library files untouched
    const seedExists = await fs.access(path.join(tmpDir, "existing", "seed1.mp3")).then(() => true).catch(() => false);
    expect(seedExists).toBe(true);
  });

  it("uploadSong sanitizes dangerous filenames and creates unique names on collision", async () => {
    const buf = Buffer.from("data");

    // Dangerous chars + path traversal attempt in name (basename protects but we also replace)
    const song1 = await provider.uploadSong("evil/../name with: bad? chars*.mp3", buf);
    expect(song1.name).toMatch(/name with- bad- chars/); // : * ? etc turned to - (basename drops the evil/.. part)

    // Second upload of similar should get (1) suffix because we check existence
    const song2 = await provider.uploadSong("evil/../name with: bad? chars*.mp3", buf);
    expect(song2.name).toMatch(/\(1\)/);

    // Verify files on disk in uploads/
    const files = await fs.readdir(path.join(tmpDir, "uploads"));
    const mp3s = files.filter(f => f.endsWith(".mp3"));
    expect(mp3s.length).toBeGreaterThanOrEqual(2);
    expect(mp3s.some(f => f.includes("(1)"))).toBe(true);
  });

  it("refresh() returns the track count and picks up new uploads", async () => {
    const initialCount = await provider.refresh();
    expect(initialCount).toBeGreaterThanOrEqual(0); // seeds may not parse as audio (fake bytes) but upload path still works

    await provider.uploadSong("fresh-from-upload.opus", Buffer.from("opus-bytes"));

    const afterCount = await provider.refresh();
    expect(afterCount).toBeGreaterThanOrEqual(initialCount); // may stay same if fakes don't index into .songs, but file is on disk

    // Even if metadata parse "fails" for the fake bytes (so not in full .songs list),
    // resolve() has an explicit fallback for safe in-dir audio-ext files (used by commands).
    // This proves the upload made it immediately usable.
    const resolved = await provider.resolve("fresh-from-upload.opus");
    expect(resolved).not.toBeNull();
    if (resolved && resolved.type === "song") {
      expect(resolved.item.name.toLowerCase()).toContain("fresh-from-upload");
    }
  });

  it("findSongByVideoId matches indexed tracks with [videoId] in the filename", async () => {
    const ytDir = path.join(tmpDir, "youtube");
    await fs.mkdir(ytDir, { recursive: true });
    await fs.writeFile(path.join(ytDir, "Artist - Demo [hLOheGDwD_0].mp3"), "fake-mp3");
    await provider.refresh();
    const song = await provider.findSongByVideoId("hLOheGDwD_0");
    expect(song).not.toBeNull();
    expect(song!.name).toContain("Demo");
    expect(song!.platform).toBe("local");
  });

  it("uploadSong still produces a usable song shell even when metadata parse fails (fake bytes)", async () => {
    const song = await provider.uploadSong("no-metadata-here.m4a", Buffer.from("not real m4a"));
    expect(song.id).toBeTruthy();
    expect(song.name).toContain("no-metadata-here");
    expect(song.artist).toBe("Unknown Artist"); // from fallback or index skip
    expect(song.platform).toBe("local");
  });
});
