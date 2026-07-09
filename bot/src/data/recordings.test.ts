import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteRecording,
  listRecordings,
  readRecording,
  safeRecordingBasename,
  writeRecording,
} from "./recordings.js";

describe("recordings store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rec-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects path traversal basenames", () => {
    expect(safeRecordingBasename("../etc/passwd.wav")).toBeNull();
    expect(safeRecordingBasename("/abs/x.webm")).toBeNull();
    expect(safeRecordingBasename("ok clip.webm")).toBeTruthy();
  });

  it("writes lists and deletes under contained root", () => {
    const meta = writeRecording(dir, "take-1.webm", Buffer.from("RIFF....WEBM"));
    expect(meta?.filename).toBe("take-1.webm");
    expect(listRecordings(dir).map((r) => r.filename)).toContain("take-1.webm");
    expect(readRecording(dir, "take-1.webm")?.toString()).toMatch(/WEBM/);
    expect(deleteRecording(dir, "take-1.webm")).toBe(true);
    expect(listRecordings(dir)).toHaveLength(0);
  });

  it("rejects empty and traversal writes", () => {
    expect(writeRecording(dir, "../x.wav", Buffer.from("abc"))).toBeNull();
    expect(writeRecording(dir, "a.wav", Buffer.alloc(0))).toBeNull();
  });
});
