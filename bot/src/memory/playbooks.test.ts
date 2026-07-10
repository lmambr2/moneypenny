import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PlaybookStore, stripSecrets } from "./playbooks.js";

describe("stripSecrets", () => {
  it("redacts secret-ish strings", () => {
    expect(stripSecrets("password=foo")).toBe("[redacted]");
  });
});

describe("PlaybookStore", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("captures and retrieves by hint", () => {
    dir = mkdtempSync(join(tmpdir(), "pb-"));
    const store = new PlaybookStore({ path: join(dir, "playbooks.json") });
    store.capture({
      hints: ["pause music", "voice under music"],
      tools: ["pause"],
      steps: ["duck", "pause", "ack"],
      outcome: "ok",
    });
    const hits = store.retrieve("please pause the music under voice", 2);
    expect(hits.length).toBe(1);
    expect(hits[0]!.tools).toContain("pause");
  });

  it("ignores failed outcomes", () => {
    dir = mkdtempSync(join(tmpdir(), "pb-"));
    const store = new PlaybookStore({ path: join(dir, "playbooks.json") });
    expect(store.capture({ hints: ["x"], tools: ["play"], outcome: "fail" })).toBeNull();
  });
});
