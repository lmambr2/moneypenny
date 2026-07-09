import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractVideoId } from "./youtube.js";
import { findSavedOnDisk, parseSavedFilename, sanitizeBase, YtLibrary } from "./ytlibrary.js";

const flush = () => new Promise((r) => setTimeout(r, 20));

describe("extractVideoId", () => {
  it("pulls the 11-char id from every URL form (the dedup key)", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=hLOheGDwD_0")).toBe("hLOheGDwD_0");
    expect(extractVideoId("https://youtu.be/hLOheGDwD_0?t=42")).toBe("hLOheGDwD_0");
    expect(extractVideoId("https://www.youtube.com/embed/hLOheGDwD_0")).toBe("hLOheGDwD_0");
    expect(extractVideoId("https://www.youtube.com/shorts/hLOheGDwD_0")).toBe("hLOheGDwD_0");
    expect(extractVideoId("https://www.youtube.com/watch?v=hLOheGDwD_0&list=PLxxx")).toBe(
      "hLOheGDwD_0",
    );
    expect(extractVideoId("hLOheGDwD_0")).toBe("hLOheGDwD_0"); // bare id
  });
  it("returns null for non-YouTube input", () => {
    expect(extractVideoId("just a song name")).toBeNull();
    expect(extractVideoId("")).toBeNull();
  });
});

describe("parseSavedFilename", () => {
  it("extracts artist and title from saved filenames", () => {
    expect(
      parseSavedFilename("Ella Langley - Choosin Texas [hLOheGDwD_0].mp3", "hLOheGDwD_0"),
    ).toEqual({
      artist: "Ella Langley",
      title: "Choosin Texas",
    });
  });
});

describe("sanitizeBase", () => {
  it("strips path-unsafe chars and appends [videoId]", () => {
    const b = sanitizeBase({ name: 'Song: "X"/Y?', artist: "Artist|Z" }, "hLOheGDwD_0");
    expect(b).toBe("ArtistZ - Song XY [hLOheGDwD_0]");
    expect(b).not.toMatch(/[/\\?%*:|"<>]/);
  });
  it("falls back to the video id when metadata is empty", () => {
    expect(sanitizeBase({ name: "", artist: "" }, "abc12345678")).toBe("abc12345678 [abc12345678]");
  });
});

describe("YtLibrary", () => {
  let dir: string;
  let db: Database.Database;
  let download: any;
  let refresh: any;
  let lib: YtLibrary;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ytlib-"));
    db = new Database(":memory:");
    download = vi.fn(async (_id: string, outDir: string, base: string) => {
      mkdirSync(outDir, { recursive: true }); // the real downloader mkdirs; mirror it
      const p = join(outDir, `${base}.mp3`);
      writeFileSync(p, "fake mp3");
      return p;
    });
    refresh = vi.fn().mockResolvedValue(1);
    lib = new YtLibrary({ db, musicDir: dir, download, refresh, logger: undefined });
  });

  it("lookup misses for an unknown id", () => {
    expect(lib.lookup("hLOheGDwD_0")).toBeNull();
  });

  it("lookup finds on-disk saves without a DB row (!test / replay dedup)", async () => {
    const outDir = join(dir, "youtube");
    mkdirSync(outDir, { recursive: true });
    const p = join(outDir, "Ella Langley - Choosin Texas [hLOheGDwD_0].mp3");
    writeFileSync(p, "fake mp3");
    expect(findSavedOnDisk(dir, "hLOheGDwD_0")).toBe(p);
    expect(lib.lookup("hLOheGDwD_0")).toBe(p);
    download.mockClear();
    lib.saveInBackground("hLOheGDwD_0", { name: "Choosin Texas", artist: "Ella Langley" });
    await flush();
    expect(download).not.toHaveBeenCalled();
  });

  it("saveInBackground downloads, records, re-indexes — then lookup hits", async () => {
    lib.saveInBackground("hLOheGDwD_0", {
      name: "Choosin Texas",
      artist: "Ella Langley",
      duration: 200,
    });
    await flush();
    expect(download).toHaveBeenCalledTimes(1);
    const [id, outDir, base] = download.mock.calls[0];
    expect(id).toBe("hLOheGDwD_0");
    expect(outDir).toBe(join(dir, "youtube"));
    expect(base).toContain("[hLOheGDwD_0]");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(lib.lookup("hLOheGDwD_0")).not.toBeNull(); // saved + file exists
  });

  it("does not re-download an already-saved video (dedup)", async () => {
    lib.saveInBackground("hLOheGDwD_0", { name: "X", artist: "Y" });
    await flush();
    download.mockClear();
    lib.saveInBackground("hLOheGDwD_0", { name: "X", artist: "Y" });
    await flush();
    expect(download).not.toHaveBeenCalled();
  });

  it("lookup returns null if the saved file was deleted (re-save allowed)", async () => {
    lib.saveInBackground("hLOheGDwD_0", { name: "X", artist: "Y" });
    await flush();
    const path = lib.lookup("hLOheGDwD_0")!;
    rmSync(path);
    expect(lib.lookup("hLOheGDwD_0")).toBeNull();
  });

  it("a failed download never persists a row (kept streaming)", async () => {
    download.mockRejectedValueOnce(new Error("yt-dlp 403"));
    lib.saveInBackground("badvideo123", { name: "X", artist: "Y" });
    await flush();
    expect(lib.lookup("badvideo123")).toBeNull();
  });
});
