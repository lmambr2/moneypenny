import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isUnderBumperDir, pinBumperToPool } from "./pin.js";

describe("pinBumperToPool", () => {
  let dir: string;
  let bumperDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mp-pin-"));
    bumperDir = join(dir, "bumpers");
    writeFileSync(join(dir, "gen.wav"), "audio");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects when nothing played yet", () => {
    expect(pinBumperToPool(null, bumperDir)).toEqual({
      ok: false,
      error: "no bumper has been played yet",
    });
  });

  it("copies last bumper into the pool", () => {
    const src = join(dir, "gen.wav");
    const out = pinBumperToPool(
      { path: src, label: "doctrine" },
      bumperDir,
      () => 1_700_000_000_000,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(existsSync(out.dest)).toBe(true);
    expect(readFileSync(out.dest).toString()).toBe("audio");
    expect(out.dest).toContain("doctrine-1700000000000.wav");
  });

  it("detects paths already in the bumper dir", () => {
    expect(isUnderBumperDir(join(bumperDir, "id.mp3"), bumperDir)).toBe(true);
    expect(isUnderBumperDir("/tmp/other.mp3", bumperDir)).toBe(false);
  });
});
