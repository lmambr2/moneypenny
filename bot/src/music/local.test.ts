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
});
