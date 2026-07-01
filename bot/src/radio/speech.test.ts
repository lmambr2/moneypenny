import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BumperCache } from "./bumper-cache.js";
import { SpeechSink } from "./speech.js";

describe("SpeechSink", () => {
  let dir: string;
  const loggerMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const logger = loggerMock as never;

  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "speech-test-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cache = () => new BumperCache({ db: new Database(":memory:"), cacheDir: dir });

  it("renders once and serves the cache on repeat", async () => {
    const tts = { synthesize: vi.fn(async () => ({ audio: Buffer.from("aa"), format: "wav" })) };
    const sink = new SpeechSink({ tts, cache: cache(), logger, voice: "af" });
    const p1 = await sink.render("hello");
    const p2 = await sink.render("hello");
    expect(p1).toBeTruthy();
    expect(p2).toBe(p1);
    expect(tts.synthesize).toHaveBeenCalledTimes(1); // second render was a cache hit
  });

  it("re-renders when the voice changes (voice is in the cache key)", async () => {
    const shared = cache();
    const tts = { synthesize: vi.fn(async () => ({ audio: Buffer.from("aa"), format: "wav" })) };
    const a = new SpeechSink({ tts, cache: shared, logger, voice: "af" });
    const b = new SpeechSink({ tts, cache: shared, logger, voice: "bm" });
    await a.render("hello");
    await b.render("hello");
    expect(tts.synthesize).toHaveBeenCalledTimes(2);
  });

  it("returns null (never throws) when TTS fails", async () => {
    const tts = { synthesize: vi.fn(async () => { throw new Error("tts down"); }) };
    const sink = new SpeechSink({ tts, cache: cache(), logger });
    expect(await sink.render("x")).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it("ignores empty text", async () => {
    const tts = { synthesize: vi.fn() };
    const sink = new SpeechSink({ tts, cache: cache(), logger });
    expect(await sink.render("   ")).toBeNull();
    expect(tts.synthesize).not.toHaveBeenCalled();
  });

  it("playSpeech renders then plays", async () => {
    const tts = { synthesize: vi.fn(async () => ({ audio: Buffer.from("aa"), format: "wav" })) };
    const player = { play: vi.fn(), resetFailures: vi.fn() };
    const sink = new SpeechSink({ tts, cache: cache(), logger, player });
    expect(await sink.playSpeech("go")).toBe(true);
    expect(player.play).toHaveBeenCalledTimes(1);
  });
});
