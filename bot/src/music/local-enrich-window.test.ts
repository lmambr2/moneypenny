import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("music-metadata", () => ({
  parseFile: vi.fn(async () => ({
    common: { title: "Night Title", artist: "Owl", album: "Moon" },
    format: { duration: 99 },
  })),
}));

import * as musicMetadata from "music-metadata";
import { LocalProvider } from "./local.js";

const parseFile = vi.mocked(musicMetadata.parseFile);

describe("LocalProvider night ID3 window", () => {
  let tmpDir: string;
  let cachePath: string;

  beforeEach(async () => {
    parseFile.mockClear();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mp-night-idx-"));
    cachePath = path.join(tmpDir, "cache.json");
    await fs.writeFile(path.join(tmpDir, "a.mp3"), "x");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("does not parse ID3 in the afternoon; uses cache after a night pass", async () => {
    const night = new LocalProvider({
      musicDir: tmpDir,
      metadataCachePath: cachePath,
      enrichWindow: { startHour: 2, endHour: 7 },
      now: () => new Date(2026, 8, 12, 3, 0, 0),
    });
    await night.waitForMetadata();
    expect(parseFile).toHaveBeenCalled();
    const titled = (await night.search("")).songs[0];
    expect(titled?.name).toBe("Night Title");

    parseFile.mockClear();
    const day = new LocalProvider({
      musicDir: tmpDir,
      metadataCachePath: cachePath,
      enrichWindow: { startHour: 2, endHour: 7 },
      now: () => new Date(2026, 8, 12, 15, 0, 0),
    });
    await day.ensureIndexed();
    await day.waitForMetadata();
    expect(parseFile).not.toHaveBeenCalled();
    const cached = (await day.search("")).songs[0];
    expect(cached?.name).toBe("Night Title");
    expect(cached?.artist).toBe("Owl");
  });
});
