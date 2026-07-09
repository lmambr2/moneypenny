import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrerecordedPool } from "./prerecorded.js";

describe("PrerecordedPool", () => {
  let dir: string;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "prerecorded-test-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("picks only audio files, ignoring non-audio", () => {
    writeFileSync(join(dir, "id.mp3"), "x");
    writeFileSync(join(dir, "sweeper.wav"), "x");
    writeFileSync(join(dir, "notes.txt"), "x");
    const pool = new PrerecordedPool({ dir, logger, random: () => 0.99 });
    expect(pool.available).toBe(true);
    const pick = pool.pick();
    expect(pick).toMatch(/\.(mp3|wav)$/);
    expect(pick).not.toMatch(/notes\.txt/);
  });

  it("is empty and returns null for a dir with no audio", () => {
    writeFileSync(join(dir, "readme.md"), "x");
    const pool = new PrerecordedPool({ dir, logger });
    expect(pool.available).toBe(false);
    expect(pool.pick()).toBeNull();
  });

  it("returns null (never throws) for a missing directory", () => {
    const pool = new PrerecordedPool({ dir: join(dir, "does-not-exist"), logger });
    expect(pool.pick()).toBeNull();
  });
});
