import { describe, expect, it, vi } from "vitest";
import {
  buildTimeCheckSpeech,
  joinSpokenLines,
  type NowPlayingInfo,
  orderBumperSources,
  parseTimeCheckTimezones,
  parseTimeCheckTimezonesDetailed,
  partitionSourcesForCycle,
  RadioBumperFactory,
  resolveStationIdLines,
} from "./bumper-factory.js";
import type { PrerecordedPool } from "./prerecorded.js";
import type { SpeechSink } from "./speech.js";
import { type BumperSource, defaultRadioConfig, type RadioConfig } from "./types.js";

function harness(opts: {
  sources?: BumperSource[];
  prerecordedPick?: string | null;
  render?: (text: string) => Promise<string | null>;
  nowPlaying?: NowPlayingInfo;
  getBumperAsset?: () => Promise<string | null>;
  retrieval?: { query: ReturnType<typeof vi.fn> } | null;
  llm?: { complete: ReturnType<typeof vi.fn> } | null;
  orgMemory?: { searchOrg: ReturnType<typeof vi.fn> } | null;
  memoryBroadcastOptIn?: boolean;
  profile?: {
    topics?: string[];
    tone?: string;
    sourceWeights?: Partial<Record<BumperSource, number>>;
  };
  /** Default 0 → weighted order preserves candidate list order (deterministic tests). */
  random?: () => number;
}) {
  const cfg: RadioConfig = {
    ...defaultRadioConfig(),
    sources: opts.sources ?? ["prerecorded", "stationId", "timeCheck", "nowPlaying"],
    memoryBroadcastOptIn: opts.memoryBroadcastOptIn ?? false,
    activeProfile: "ops",
    profiles: {
      ops: {
        name: "ops",
        bumper: opts.profile ?? { topics: ["refinery yields"] },
      },
    },
  };
  const prerecorded = {
    pick: vi.fn(() => opts.prerecordedPick ?? null),
  } as unknown as PrerecordedPool;
  const renderFn = vi.fn(
    opts.render ??
      (async (t: string, _source?: string, _opts?: { floor?: string[] }) =>
        `/cache/${t.length}.wav`),
  );
  const speech = { render: renderFn } as unknown as SpeechSink;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
  const factory = new RadioBumperFactory({
    getConfig: () => cfg,
    prerecorded,
    speech,
    getNowPlaying: () => opts.nowPlaying ?? {},
    getBumperAsset: opts.getBumperAsset,
    stationName: "Moneypenny Radio",
    getRetrieval: () => (opts.retrieval === undefined ? null : opts.retrieval) as never,
    getLlm: () => (opts.llm === undefined ? null : opts.llm) as never,
    getOrgMemory: () => (opts.orgMemory === undefined ? null : opts.orgMemory) as never,
    logger,
    now: () => new Date(2026, 5, 30, 14, 5).getTime(),
    random: opts.random ?? (() => 0),
  });
  return { factory, prerecorded, renderFn, logger };
}

describe("resolveStationIdLines / time zones", () => {
  it("defaults station ID templates with {name}", () => {
    expect(resolveStationIdLines("Moneypenny", [])).toEqual([
      "This is Moneypenny.",
      "You're listening to Moneypenny.",
      "Stay tuned on Moneypenny.",
    ]);
  });

  it("honors custom station ID lines", () => {
    expect(resolveStationIdLines("Penny", ["This is {name} Radio.", "Stay sharp."])).toEqual([
      "This is Penny Radio.",
      "Stay sharp.",
    ]);
  });

  it("joins all station ID lines into one spoken package", () => {
    expect(
      joinSpokenLines([
        "This is Colonel Moneypenny",
        "You are listening to the voice of the Talon Group",
        "Stay tuned for announcements from the Chairman",
      ]),
    ).toBe(
      "This is Colonel Moneypenny. You are listening to the voice of the Talon Group. Stay tuned for announcements from the Chairman.",
    );
  });

  it("builds multi-zone time checks with labels", () => {
    const ms = new Date(2026, 5, 30, 14, 5).getTime(); // local 2:05 PM
    const zones = parseTimeCheckTimezones(["UTC|UTC", "local|here"]);
    expect(zones).toHaveLength(2);
    const speech = buildTimeCheckSpeech(ms, zones);
    expect(speech).toMatch(/^The time is /);
    expect(speech).toMatch(/UTC/);
    expect(speech).toMatch(/here/);
  });

  it("aliases America/Seattle → Los_Angeles so third Pacific line is kept", () => {
    const { zones, skipped } = parseTimeCheckTimezonesDetailed([
      "America/New_York|The Capitol Wasteland",
      "America/Denver|Stargate Command",
      "America/Seattle|CHAZ",
    ]);
    expect(skipped).toEqual([]);
    expect(zones).toHaveLength(3);
    expect(zones[2]).toMatchObject({ zone: "America/Los_Angeles", label: "CHAZ" });
    const speech = buildTimeCheckSpeech(Date.UTC(2026, 5, 30, 18, 5), zones);
    expect(speech).toMatch(/Capitol Wasteland/);
    expect(speech).toMatch(/Stargate Command/);
    expect(speech).toMatch(/CHAZ/);
  });

  it("single local zone keeps classic phrasing", () => {
    const ms = new Date(2026, 5, 30, 14, 5).getTime();
    expect(buildTimeCheckSpeech(ms, parseTimeCheckTimezones([]))).toBe("The time is 2:05 PM.");
  });

  it("plays all custom station ID lines in one build", async () => {
    const cfg: RadioConfig = {
      ...defaultRadioConfig(),
      enabled: true,
      sources: ["stationId"],
      stationIdLines: [
        "This is Colonel Moneypenny",
        "You are listening to the voice of the Talon Group",
        "Stay tuned for announcements from the Chairman",
      ],
    };
    const renderFn = vi.fn(async (t: string) => `/cache/${t.length}.wav`);
    const factory = new RadioBumperFactory({
      getConfig: () => cfg,
      prerecorded: { pick: () => null } as never,
      speech: { render: renderFn } as never,
      getNowPlaying: () => ({}),
      stationName: "Moneypenny",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      random: () => 0,
    });
    const b = await factory.build({ slot: "bumper", sources: ["stationId"] });
    expect(b?.label).toBe("stationId");
    expect(renderFn).toHaveBeenCalledWith(
      expect.stringContaining("Colonel Moneypenny"),
      "stationId",
    );
    expect(renderFn.mock.calls[0]![0]).toContain("Talon Group");
    expect(renderFn.mock.calls[0]![0]).toContain("Chairman");
  });
});

describe("orderBumperSources / partitionSourcesForCycle", () => {
  it("with rng→0 preserves candidate order (equal weights)", () => {
    expect(
      orderBumperSources(["prerecorded", "stationId", "timeCheck"], undefined, () => 0),
    ).toEqual(["prerecorded", "stationId", "timeCheck"]);
  });

  it("honors sourceWeights (heavy weight tends to first)", () => {
    const order = orderBumperSources(
      ["prerecorded", "stationId"],
      { prerecorded: 1, stationId: 99 },
      () => 0.5,
    );
    expect(order[0]).toBe("stationId");
  });

  it("defers used sources until the rest of the cycle is exhausted", () => {
    const used = new Set<BumperSource>(["prerecorded"]);
    const p = partitionSourcesForCycle(["prerecorded", "stationId", "timeCheck"], used);
    expect(p.fresh).toEqual(["stationId", "timeCheck"]);
    expect(p.fallback).toEqual(["prerecorded"]);
    expect(p.resetCycle).toBe(false);
  });

  it("resets the cycle when every candidate was already used", () => {
    const used = new Set<BumperSource>(["prerecorded", "stationId"]);
    const p = partitionSourcesForCycle(["prerecorded", "stationId"], used);
    expect(p.resetCycle).toBe(true);
    expect(p.fresh).toEqual(["prerecorded", "stationId"]);
    expect(p.fallback).toEqual([]);
  });
});

describe("RadioBumperFactory.prewarm", () => {
  it("renders station liners and upcoming time checks into the speech cache", async () => {
    const { factory, renderFn } = harness({});
    const result = await factory.prewarm({ hoursAhead: 2 });
    expect(result.rendered).toBeGreaterThan(3);
    expect(result.failed).toBe(0);
    expect(renderFn).toHaveBeenCalledWith(
      expect.stringContaining("This is Moneypenny Radio."),
      "stationId",
      expect.anything(),
    );
    expect(renderFn.mock.calls.some((c) => c[1] === "timeCheck")).toBe(true);
  });

  it("optionally prewarms doctrine per profile topic", async () => {
    const retrieval = {
      query: vi.fn(async () => [{ text: "Refineries run cool.", source: "ops.md" }]),
    };
    const llm = {
      complete: vi.fn(async () => "Refineries are running cool out there."),
    };
    const { factory, renderFn } = harness({
      sources: ["doctrine"],
      retrieval,
      llm,
      profile: { topics: ["refinery"] },
    });
    const result = await factory.prewarm({ includeDoctrine: true, hoursAhead: 1 });
    expect(result.rendered).toBeGreaterThan(0);
    expect(llm.complete).toHaveBeenCalled();
    expect(renderFn.mock.calls.some((c) => c[1] === "doctrine" || c[1] === "stationId")).toBe(true);
  });
});

describe("RadioBumperFactory", () => {
  it("can pick prerecorded when ordered first (rng→0) and asset available", async () => {
    const { factory, renderFn } = harness({ prerecordedPick: "/bumpers/id.mp3" });
    const b = await factory.build({ slot: "bumper", sources: ["prerecorded", "stationId"] });
    expect(b).toEqual({ path: "/bumpers/id.mp3", label: "prerecorded" });
    expect(renderFn).not.toHaveBeenCalled();
  });

  it("after prerecorded wins, next build tries other sources first (cycle)", async () => {
    const { factory, renderFn } = harness({
      prerecordedPick: "/bumpers/id.mp3",
      random: () => 0,
    });
    const a = await factory.build({ slot: "bumper", sources: ["prerecorded", "stationId"] });
    expect(a?.label).toBe("prerecorded");
    const b = await factory.build({ slot: "bumper", sources: ["prerecorded", "stationId"] });
    // prerecorded is "used this cycle" → stationId is the only fresh source
    expect(b?.label).toBe("stationId");
    expect(renderFn).toHaveBeenCalled();
    // Third: both used → cycle reset, but winner (stationId) stays used so prerecorded is fresh
    const c = await factory.build({ slot: "bumper", sources: ["prerecorded", "stationId"] });
    expect(c?.label).toBe("prerecorded");
  });

  it("cycles through three sources before repeating a winner", async () => {
    const labels: string[] = [];
    const { factory } = harness({
      prerecordedPick: "/bumpers/id.mp3",
      nowPlaying: { previous: { name: "Song" } },
      random: () => 0, // always first of remaining fresh list (input order)
      sources: ["prerecorded", "stationId", "nowPlaying"],
    });
    for (let i = 0; i < 3; i++) {
      const b = await factory.build({
        slot: "bumper",
        sources: ["prerecorded", "stationId", "nowPlaying"],
      });
      labels.push(b?.label ?? "null");
    }
    expect(labels).toEqual(["prerecorded", "stationId", "nowPlaying"]);
  });

  it("marks a failed source as used so the next break skips it", async () => {
    const { factory, renderFn } = harness({
      prerecordedPick: null, // prerecorded always fails
      random: () => 0,
    });
    const a = await factory.build({
      slot: "bumper",
      sources: ["prerecorded", "stationId", "timeCheck"],
    });
    // Tries prerecorded (fail), then stationId (ok)
    expect(a?.label).toBe("stationId");
    const b = await factory.build({
      slot: "bumper",
      sources: ["prerecorded", "stationId", "timeCheck"],
    });
    // prerecorded + stationId used → only timeCheck is fresh
    expect(b?.label).toBe("timeCheck");
    expect(renderFn.mock.calls.some((c) => c[1] === "timeCheck")).toBe(true);
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
    expect(renderFn).toHaveBeenCalledWith(
      "This is Moneypenny Radio. You're listening to Moneypenny Radio. Stay tuned on Moneypenny Radio.",
      "stationId",
    );
  });

  it("honors a single-source slot", async () => {
    const { factory, renderFn } = harness({});
    await factory.build({ slot: "bumper", sources: ["timeCheck"] });
    expect(renderFn).toHaveBeenCalledWith("The time is 2:05 PM.", "timeCheck");
  });

  it("topic override targets doctrine even when other sources are listed", async () => {
    const retrieval = {
      query: vi.fn(async () => [{ text: "Mining SOP.", source: "ops.md" }]),
    };
    const llm = { complete: vi.fn(async () => "Stay sharp on mining SOP.") };
    const { factory, renderFn } = harness({
      sources: ["prerecorded", "doctrine"],
      prerecordedPick: "/bumpers/id.mp3",
      retrieval,
      llm,
    });
    const b = await factory.build({
      slot: "bumper",
      sources: ["prerecorded", "doctrine"],
      topic: "mining",
    });
    expect(b?.label).toBe("doctrine");
    expect(llm.complete).toHaveBeenCalled();
    expect(renderFn).toHaveBeenCalled();
  });

  it("skips a globally-disabled source", async () => {
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
    expect(
      await factory.build({ slot: "bumper", sources: ["prerecorded", "nowPlaying"] }),
    ).toBeNull();
  });

  it("memory resolves to null when opt-in is off (OQ1)", async () => {
    const { factory } = harness({
      sources: ["memory"],
      memoryBroadcastOptIn: false,
      orgMemory: { searchOrg: vi.fn(async () => [{ fact: "x" }]) },
      llm: { complete: vi.fn(async () => "hi") },
    });
    expect(await factory.build({ slot: "bumper", sources: ["memory"] })).toBeNull();
  });
});
