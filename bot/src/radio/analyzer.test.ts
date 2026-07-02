import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { RadioAnalyzer, parseKey, parseBpm, type CommandRunner } from "./analyzer.js";
import { TagStore } from "./tag-store.js";
import { defaultRadioConfig } from "./types.js";

describe("parseKey", () => {
  it("keeps the raw key and derives scale when obvious", () => {
    expect(parseKey("Am")).toEqual({ musicalKey: "Am", keyScale: "minor" });
    expect(parseKey("8A")).toEqual({ musicalKey: "8A", keyScale: "minor" });
    expect(parseKey("8B")).toEqual({ musicalKey: "8B", keyScale: "major" });
    expect(parseKey("C major")).toMatchObject({ keyScale: "major" });
    expect(parseKey("F#")).toEqual({ musicalKey: "F#" }); // scale unknown
    expect(parseKey("  \n ")).toEqual({});
  });
});

describe("parseBpm", () => {
  it("reads a labeled bpm", () => expect(parseBpm("estimated: 128 bpm")).toBe(128));
  it("reads a lone number", () => expect(parseBpm("90")).toBe(90));
  it("computes bpm from beat-onset times (median interval)", () => {
    expect(parseBpm("0.5\n1.0\n1.5\n2.0")).toBe(120); // 0.5s interval → 120 bpm
  });
  it("rejects out-of-range and garbage", () => {
    expect(parseBpm("6\n12\n18")).toBeUndefined(); // 6s interval → 10 bpm, clamped out
    expect(parseBpm("not audio")).toBeUndefined();
  });
});

function analyzer(over: { key?: string; bpm?: string; found?: boolean } = {}) {
  const tags = new TagStore({ db: new Database(":memory:") });
  const run: CommandRunner = vi.fn(async (cmd, args) => {
    if (args[0] === "--help") return { stdout: "", ok: true, found: over.found ?? true };
    if (cmd.includes("keyfinder")) return { stdout: over.key ?? "Am", ok: true, found: true };
    return { stdout: over.bpm ?? "0.5\n1.0\n1.5\n2.0", ok: true, found: true }; // aubio → 120 bpm
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  const a = new RadioAnalyzer({ tags, getConfig: () => defaultRadioConfig(), logger, run });
  return { a, tags, run };
}

describe("RadioAnalyzer", () => {
  it("writes key/BPM to the overlay as source=analyzer", async () => {
    const { a, tags } = analyzer();
    const r = await a.analyzeTrack({ absPath: "/m/a.mp3", trackKey: "k" });
    expect(r).toEqual({ musicalKey: "Am", bpm: 120 });
    expect(tags.get("k")).toMatchObject({ musicalKey: "Am", keyScale: "minor", bpm: 120, source: "analyzer" });
  });

  it("skips a track already analyzed (unless forced)", async () => {
    const { a, run } = analyzer();
    await a.analyzeTrack({ absPath: "/m/a.mp3", trackKey: "k" });
    const callsAfterFirst = (run as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(await a.analyzeTrack({ absPath: "/m/a.mp3", trackKey: "k" })).toBeNull(); // cached
    expect((run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
    expect(await a.analyzeTrack({ absPath: "/m/a.mp3", trackKey: "k" }, { force: true })).not.toBeNull();
  });

  it("no-ops gracefully when the binaries are missing", async () => {
    const { a, tags } = analyzer({ found: false });
    expect(await a.analyzeTrack({ absPath: "/m/a.mp3", trackKey: "k" })).toBeNull();
    expect(tags.get("k")).toBeNull();
    expect(await a.analyzeAll([{ absPath: "/m/a.mp3", trackKey: "k" }])).toEqual({ analyzed: 0, skipped: 1 });
  });

  it("tallies a batch", async () => {
    const { a } = analyzer();
    const out = await a.analyzeAll([
      { absPath: "/m/a.mp3", trackKey: "k1" },
      { absPath: "/m/b.mp3", trackKey: "k2" },
    ]);
    expect(out).toEqual({ analyzed: 2, skipped: 0 });
  });
});
