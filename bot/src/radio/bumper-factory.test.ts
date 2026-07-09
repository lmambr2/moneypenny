import { describe, expect, it, vi } from "vitest";
import { type NowPlayingInfo, RadioBumperFactory } from "./bumper-factory.js";
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
  profile?: { topics?: string[]; tone?: string };
}) {
  const cfg: RadioConfig = {
    ...defaultRadioConfig(),
    sources: opts.sources ?? ["prerecorded", "stationId", "timeCheck", "nowPlaying"],
    memoryBroadcastOptIn: opts.memoryBroadcastOptIn ?? false,
    activeProfile: "ops",
    profiles: { ops: { name: "ops", bumper: opts.profile ?? { topics: ["refinery yields"] } } },
  };
  const prerecorded = {
    pick: vi.fn(() => opts.prerecordedPick ?? null),
  } as unknown as PrerecordedPool;
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
    getRetrieval: () => (opts.retrieval === undefined ? null : opts.retrieval) as never,
    getLlm: () => (opts.llm === undefined ? null : opts.llm) as never,
    getOrgMemory: () => (opts.orgMemory === undefined ? null : opts.orgMemory) as never,
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
    expect(
      await factory.build({ slot: "bumper", sources: ["prerecorded", "nowPlaying"] }),
    ).toBeNull();
  });

  it("memory resolves to null when opt-in is off (OQ1)", async () => {
    const { factory } = harness({
      sources: ["memory"],
      memoryBroadcastOptIn: false,
      orgMemory: { searchOrg: vi.fn(async () => [{ fact: "Fleet CO is Alice" }]) },
      llm: { complete: vi.fn(async () => "Fleet CO is Alice.") },
    });
    expect(await factory.build({ slot: "bumper", sources: ["memory"] })).toBeNull();
  });

  it("memory bumper speaks org KG when opted in", async () => {
    const searchOrg = vi.fn(async () => [{ fact: "Fleet CO is Alice as of 2026" }]);
    const complete = vi.fn(async () => "Fleet command is with Alice.");
    const { factory, renderFn } = harness({
      sources: ["memory"],
      memoryBroadcastOptIn: true,
      orgMemory: { searchOrg },
      llm: { complete },
    });
    const b = await factory.build({ slot: "bumper", sources: ["memory"] });
    expect(b?.label).toBe("memory");
    expect(searchOrg).toHaveBeenCalled();
    expect(complete).toHaveBeenCalled();
    expect(renderFn).toHaveBeenCalled();
    const [, source] = renderFn.mock.calls[0] as unknown as [string, string];
    expect(source).toBe("memory");
  });
});

describe("say (§12 operator liner)", () => {
  it("speaks capped text with the non-cacheable operator floor", async () => {
    const { factory, renderFn } = harness({});
    const long = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
    const b = await factory.say(long);
    expect(b?.label).toBe("say");
    const [text, source, opts] = renderFn.mock.calls[0] as unknown as [
      string,
      string,
      { floor: string[] },
    ];
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(75); // 30s cap
    expect(source).toBe("say");
    expect(opts.floor).toContain("operator"); // never enters the persistent cache
  });

  it("rejects empty text", async () => {
    const { factory, renderFn } = harness({});
    expect(await factory.say("   ")).toBeNull();
    expect(renderFn).not.toHaveBeenCalled();
  });
});

describe("doctrine source (§6.1/§6.2/§6.3)", () => {
  const retrieval = (text: string | null) => ({
    query: vi.fn(async () => (text ? [{ text, source: "doctrine/x.md" }] : [])),
  });
  const llm = (reply: string) => ({ complete: vi.fn(async () => reply) });

  it("floored retrieval → LLM rewrite → render with the floor", async () => {
    const r = retrieval("Quantanium must be refined within 40 minutes.");
    const l = llm("Remember: quantanium sours in forty minutes — refine it fast.");
    const { factory, renderFn } = harness({ sources: ["doctrine"], retrieval: r, llm: l });

    const b = await factory.build({ slot: "bumper", sources: ["doctrine"] }, ["unclassified"]);
    expect(b?.label).toBe("doctrine");
    // Floor reaches the retrieval filter BEFORE the model sees text (§6.3).
    expect(r.query).toHaveBeenCalledWith("refinery yields", 3, ["unclassified"]);
    expect(renderFn).toHaveBeenCalledWith(expect.stringContaining("quantanium"), "doctrine", {
      floor: ["unclassified"],
    });
  });

  it("caps the script to the word budget", async () => {
    const long = Array.from({ length: 300 }, (_, i) => `w${i}`).join(" ");
    const { factory, renderFn } = harness({
      sources: ["doctrine"],
      retrieval: retrieval("material"),
      llm: llm(long),
    });
    await factory.build({ slot: "bumper", sources: ["doctrine"] }, ["unclassified"]);
    const script = (renderFn.mock.calls[0] as unknown[])[0] as string;
    expect(script.split(/\s+/).length).toBeLessThanOrEqual(75); // 30s * 2.5 wpm-per-s
  });

  it("LLM/RAG down → falls through to the next source (canned fallback)", async () => {
    const { factory, renderFn } = harness({
      sources: ["doctrine", "stationId"],
      retrieval: null, // RAG off
      llm: llm("never used"),
    });
    const b = await factory.build({ slot: "bumper", sources: ["doctrine", "stationId"] }, [
      "unclassified",
    ]);
    expect(b?.label).toBe("stationId"); // music/canned never blocked by a dead substrate
    expect(renderFn).toHaveBeenCalledWith("This is Moneypenny Radio.", "stationId");
  });

  it("no retrieved material → null (invent nothing)", async () => {
    const { factory } = harness({
      sources: ["doctrine"],
      retrieval: retrieval(null),
      llm: llm("made up"),
    });
    expect(
      await factory.build({ slot: "bumper", sources: ["doctrine"] }, ["unclassified"]),
    ).toBeNull();
  });

  it("no curated topics → null (nothing to talk about)", async () => {
    const { factory } = harness({
      sources: ["doctrine"],
      retrieval: retrieval("x"),
      llm: llm("y"),
      profile: { topics: [] },
    });
    expect(
      await factory.build({ slot: "bumper", sources: ["doctrine"] }, ["unclassified"]),
    ).toBeNull();
  });
});
