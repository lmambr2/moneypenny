import { describe, it, expect, vi, beforeEach } from "vitest";
import { RadioBumperFactory, type NowPlayingInfo } from "./bumper-factory.js";
import type { PrerecordedPool } from "./prerecorded.js";
import type { SpeechSink } from "./speech.js";
import { defaultRadioConfig, type BumperSource, type RadioConfig } from "./types.js";

function harness(opts: {
  sources?: BumperSource[];
  prerecordedPick?: string | null;
  render?: (text: string) => Promise<string | null>;
  nowPlaying?: NowPlayingInfo;
  getBumperAsset?: () => Promise<string | null>;
}) {
  const cfg: RadioConfig = {
    ...defaultRadioConfig(),
    sources: opts.sources ?? ["prerecorded", "stationId", "timeCheck", "nowPlaying"],
  };
  const prerecorded = { pick: vi.fn(() => opts.prerecordedPick ?? null) } as unknown as PrerecordedPool;
  const renderFn = vi.fn(opts.render ?? (async (t: string) => `/cache/${t.length}.wav`));
  const speech = { render: renderFn } as unknown as SpeechSink;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  const factory = new RadioBumperFactory({
    getConfig: () => cfg,
    prerecorded,
    speech,
    getNowPlaying: () => opts.nowPlaying ?? {},
    getBumperAsset: opts.getBumperAsset,
    stationName: "Moneypenny Radio",
    logger,
    now: () => new Date(2026, 5, 30, 14, 5).getTime(),
  });
  return { factory, prerecorded, renderFn };
}

describe("RadioBumperFactory", () => {
  it("prefers prerecorded when an asset is available", async () => {
    const { factory, renderFn } = harness({ prerecordedPick: "/bumpers/id.mp3" });
    const b = await factory.build({ slot: "bumper", sources: ["prerecorded", "stationId"] });
    expect(b).toEqual({ path: "/bumpers/id.mp3", label: "prerecorded" });
    expect(renderFn).not.toHaveBeenCalled();
  });

  it("prefers a bumper-flagged library asset over the dir pool (§9.2)", async () => {
    const { factory, prerecorded } = harness({
      prerecordedPick: "/bumpers/dir.mp3",
      getBumperAsset: async () => "/music/flagged-jingle.mp3",
    });
    const b = await factory.build({ slot: "bumper", sources: ["prerecorded"] });
    expect(b).toEqual({ path: "/music/flagged-jingle.mp3", label: "prerecorded" });
    expect(prerecorded.pick).not.toHaveBeenCalled();
  });

  it("falls back to the dir pool when no flagged asset resolves", async () => {
    const { factory } = harness({
      prerecordedPick: "/bumpers/dir.mp3",
      getBumperAsset: async () => null,
    });
    const b = await factory.build({ slot: "bumper", sources: ["prerecorded"] });
    expect(b).toEqual({ path: "/bumpers/dir.mp3", label: "prerecorded" });
  });

  it("falls through to the next source when prerecorded is empty", async () => {
    const { factory, renderFn } = harness({ prerecordedPick: null });
    const b = await factory.build({ slot: "bumper", sources: ["prerecorded", "stationId"] });
    expect(b?.label).toBe("stationId");
    expect(renderFn).toHaveBeenCalledWith("This is Moneypenny Radio.", "stationId");
  });

  it("honors slot source order", async () => {
    const { factory, renderFn } = harness({});
    await factory.build({ slot: "bumper", sources: ["timeCheck"] });
    expect(renderFn).toHaveBeenCalledWith("The time is 2:05 PM.", "timeCheck");
  });

  it("skips a globally-disabled source", async () => {
    // stationId not in cfg.sources → the slot can't use it, falls to nowPlaying
    const { factory, renderFn } = harness({
      sources: ["nowPlaying"],
      nowPlaying: { previous: { name: "Aurora", artist: "VNV" } },
    });
    const b = await factory.build({ slot: "bumper", sources: ["stationId", "nowPlaying"] });
    expect(b?.label).toBe("nowPlaying");
    expect(renderFn).toHaveBeenCalledWith("That was Aurora by VNV.", "nowPlaying");
  });

  it("builds now-playing text from previous + next", async () => {
    const { factory, renderFn } = harness({
      nowPlaying: { previous: { name: "A" }, next: { name: "B", artist: "C" } },
    });
    await factory.build({ slot: "bumper", sources: ["nowPlaying"] });
    expect(renderFn).toHaveBeenCalledWith("That was A. Up next, B by C.", "nowPlaying");
  });

  it("returns null when nowPlaying has nothing to say", async () => {
    const { factory } = harness({ sources: ["nowPlaying"], nowPlaying: {} });
    expect(await factory.build({ slot: "bumper", sources: ["nowPlaying"] })).toBeNull();
  });

  it("returns null when every source yields nothing", async () => {
    const { factory } = harness({
      sources: ["prerecorded", "nowPlaying"],
      prerecordedPick: null,
      nowPlaying: {},
    });
    expect(await factory.build({ slot: "bumper", sources: ["prerecorded", "nowPlaying"] })).toBeNull();
  });

  it("doctrine/memory resolve to null in R-R1", async () => {
    const { factory } = harness({ sources: ["doctrine", "memory"] });
    expect(await factory.build({ slot: "bumper", sources: ["doctrine", "memory"] })).toBeNull();
  });
});
