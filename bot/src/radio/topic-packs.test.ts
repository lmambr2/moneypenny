import { describe, expect, it } from "vitest";
import { defaultRadioConfig } from "./types.js";

describe("default radio topic packs (R1)", () => {
  it("ships lobby/focus/combat/mining with curated doctrine-aligned topics", () => {
    const cfg = defaultRadioConfig();
    expect(Object.keys(cfg.profiles).sort()).toEqual(
      expect.arrayContaining(["lobby", "focus", "combat", "mining"]),
    );
    expect(cfg.profiles.lobby.bumper?.topics).toEqual(
      expect.arrayContaining(["station", "welcome"]),
    );
    expect(cfg.profiles.combat.bumper?.topics).toEqual(
      expect.arrayContaining(["combat doctrine", "ROE"]),
    );
    expect(cfg.profiles.mining.bumper?.topics).toEqual(
      expect.arrayContaining(["mining", "logistics"]),
    );
    expect(cfg.profiles.focus.bumper?.topics).toEqual(
      expect.arrayContaining(["ops", "briefing"]),
    );
  });
});
