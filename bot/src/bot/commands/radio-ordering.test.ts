import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { TagStore } from "../../radio/tag-store.js";
import { defaultRadioConfig } from "../../radio/types.js";
import { RadioCommands } from "./radio-commands.js";

function makeRadio(opts: { ratingWeight?: boolean; harmonic?: boolean }) {
  const tagStore = new TagStore({ db: new Database(":memory:") });
  // Scores: high rated track vs low
  tagStore.upsert("low", { genre: "ambient", musicalKey: "F#", keyScale: "major" }, "manual");
  tagStore.upsert("high", { genre: "ambient", musicalKey: "G", keyScale: "major" }, "manual");
  tagStore.upsert("mid", { genre: "ambient", musicalKey: "C", keyScale: "major" }, "manual");
  // Many raters so Bayesian smoothed scores separate strongly (C=5 prior).
  for (let i = 0; i < 12; i++) {
    tagStore.rate("high", `web:h${i}`, 5);
    tagStore.rate("low", `web:l${i}`, 1);
    if (i < 4) tagStore.rate("mid", `web:m${i}`, 3);
  }

  const radio = defaultRadioConfig();
  radio.ratingWeight = {
    enabled: opts.ratingWeight !== false,
    exponent: 2,
    maxRatio: 10,
  };
  radio.harmonicSequencing = !!opts.harmonic;

  const deps = {
    config: { radio, aceStepAutoFill: false },
    tagStore,
    queue: { clear: vi.fn(), add: vi.fn(), play: vi.fn(), current: vi.fn() },
    player: { getState: () => "idle", resetFailures: vi.fn() },
    playback: { resolveAndPlay: vi.fn(), searchFirst: vi.fn() },
    getProvider: vi.fn(),
  } as never;

  return { cmds: new RadioCommands(deps, async () => []), tagStore };
}

describe("RadioCommands.applyPoolOrdering", () => {
  it("rating weight prefers high scores (enabled)", () => {
    const { cmds } = makeRadio({ ratingWeight: true, harmonic: false });
    let highFirst = 0;
    const trials = 200;
    for (let i = 0; i < trials; i++) {
      const out = cmds.applyPoolOrdering(["low", "high"]);
      if (out[0] === "high") highFirst++;
    }
    // Two-key bag with 5★ vs 1★ — expect clear majority, not 50/50
    expect(highFirst).toBeGreaterThan(trials * 0.55);
  });

  it("harmonic sequencing puts C then G before far F# when starting from mid=C", () => {
    const { cmds } = makeRadio({ ratingWeight: false, harmonic: true });
    // Disable rating by enabled:false
    const out = cmds.applyPoolOrdering(["mid", "low", "high"]);
    // mid=C(8B), high=G(9B) adjacent, low=F#(2B) far
    expect(out[0]).toBe("mid");
    expect(out[1]).toBe("high");
    expect(out[2]).toBe("low");
  });
});
