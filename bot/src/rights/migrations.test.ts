import { describe, expect, it } from "vitest";
import type { RightsConfig } from "./index.js";
import { CURRENT_RIGHTS_VERSION, migrateRightsConfig } from "./migrations.js";

/** A frozen June-era ruleset shaped like the real one that broke !radio. */
const frozen = (): RightsConfig => ({
  defaultAllow: ["play", "skip", "help"],
  commandGroups: {
    dj: ["stop", "vol"],
    admin: ["stop", "move"],
    analyst: ["analyst", "agent"],
  },
  superAdminUids: ["uid-x"],
  rules: [{ name: "guest", match: { serverGroups: ["8"] }, deny: ["@dj"] }],
});

describe("migrateRightsConfig", () => {
  it("appends new publics + group tokens to a frozen ruleset", () => {
    const m = migrateRightsConfig(frozen(), 0);
    expect(m.version).toBe(CURRENT_RIGHTS_VERSION);
    expect(m.rights!.defaultAllow).toContain("radio");
    expect(m.rights!.defaultAllow).toContain("playnext");
    expect(m.rights!.commandGroups!.dj).toContain("radio.say");
    expect(m.rights!.commandGroups!.admin).toContain("radio.power");
    expect(m.rights!.commandGroups!.admin).toContain("radio.pin");
    expect(m.rights!.commandGroups!.analyst).toContain("intsum");
    expect(m.applied.length).toBeGreaterThan(0);
  });

  it("is append-only: existing grants, rules, superAdmins untouched", () => {
    const m = migrateRightsConfig(frozen(), 0);
    expect(m.rights!.defaultAllow!.slice(0, 3)).toEqual(["play", "skip", "help"]);
    expect(m.rights!.commandGroups!.dj.slice(0, 2)).toEqual(["stop", "vol"]);
    expect(m.rights!.rules).toEqual(frozen().rules);
    expect(m.rights!.superAdminUids).toEqual(["uid-x"]);
  });

  it("applies exactly once: a later admin removal is never re-added", () => {
    const first = migrateRightsConfig(frozen(), 0);
    // Admin deliberately strips radio.say from @dj afterwards.
    first.rights!.commandGroups!.dj = first.rights!.commandGroups!.dj.filter(
      (t) => t !== "radio.say",
    );
    const second = migrateRightsConfig(first.rights, first.version);
    expect(second.applied).toEqual([]);
    expect(second.rights!.commandGroups!.dj).not.toContain("radio.say");
  });

  it("skips groups the admin deleted (never recreates them)", () => {
    const r = frozen();
    delete r.commandGroups!.dj;
    const m = migrateRightsConfig(r, 0);
    expect(m.rights!.commandGroups!.dj).toBeUndefined();
    // Other groups still receive tokens; dj is never recreated.
    expect(m.rights!.commandGroups!.admin).toContain("mute");
    expect(m.applied.some((a) => a.includes("@dj"))).toBe(false);
  });

  it("adds G4 moderation tokens to admin (and mod when present)", () => {
    const withMod: RightsConfig = {
      ...frozen(),
      commandGroups: {
        ...frozen().commandGroups!,
        mod: ["move"],
      },
    };
    const m = migrateRightsConfig(withMod, 0);
    expect(m.rights!.commandGroups!.admin).toContain("mute");
    expect(m.rights!.commandGroups!.admin).toContain("kick");
    expect(m.rights!.commandGroups!.admin).toContain("recording");
    expect(m.rights!.commandGroups!.admin).toContain("workorder.clear");
    expect(m.rights!.commandGroups!.mod).toContain("mute");
    expect(m.rights!.commandGroups!.mod).toContain("kick");
  });

  it("no-ops without a custom ruleset (legacy default build)", () => {
    const m = migrateRightsConfig(undefined, 0);
    expect(m.rights).toBeUndefined();
    expect(m.applied).toEqual([]);
    expect(m.version).toBe(CURRENT_RIGHTS_VERSION);
  });

  it("idempotent on an already-hand-patched ruleset (the Pi case)", () => {
    const patched = migrateRightsConfig(frozen(), 0).rights;
    const again = migrateRightsConfig(patched, 0); // version never persisted
    expect(again.applied).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = frozen();
    migrateRightsConfig(input, 0);
    expect(input.defaultAllow).toEqual(["play", "skip", "help"]);
    expect(input.commandGroups!.dj).toEqual(["stop", "vol"]);
  });
});
