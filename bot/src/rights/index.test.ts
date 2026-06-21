import { describe, it, expect } from "vitest";
import { RightsEngine, defaultRightsConfig, isRightsConfig, type Subject } from "./index.js";
import { PUBLIC_COMMANDS, ADMIN_COMMANDS } from "../bot/commands.js";

const member: Subject = { uid: "member-uid", serverGroups: ["100"] };
const officer: Subject = { uid: "officer-uid", serverGroups: ["105"] };
const owner: Subject = { uid: "owner-uid", serverGroups: ["1"] };

describe("RightsEngine", () => {
  it("allows defaultAllow commands for everyone", () => {
    const e = new RightsEngine({ defaultAllow: ["play", "vote"] });
    expect(e.can(member, "play")).toBe(true);
    expect(e.can(member, "vote")).toBe(true);
    expect(e.can(member, "stop")).toBe(false);
  });

  it("matches rules by server-group and expands @groups", () => {
    const e = new RightsEngine({
      defaultAllow: ["play"],
      commandGroups: { admin: ["stop", "clear"] },
      rules: [{ name: "officers", match: { serverGroups: ["105"] }, allow: ["@admin"] }],
    });
    expect(e.can(officer, "stop")).toBe(true);
    expect(e.can(officer, "clear")).toBe(true);
    expect(e.can(member, "stop")).toBe(false); // member not in field-grade group
  });

  it("matches rules by uid", () => {
    const e = new RightsEngine({
      rules: [{ match: { uids: ["member-uid"] }, allow: ["secret"] }],
    });
    expect(e.can(member, "secret")).toBe(true);
    expect(e.can(officer, "secret")).toBe(false);
  });

  it("superAdminUids bypass everything", () => {
    const e = new RightsEngine({ superAdminUids: ["owner-uid"] });
    expect(e.can(owner, "anything-at-all")).toBe(true);
    expect(e.can(member, "anything-at-all")).toBe(false);
  });

  it("'*' allows all commands", () => {
    const e = new RightsEngine({ rules: [{ match: { serverGroups: ["105"] }, allow: ["*"] }] });
    expect(e.can(officer, "stop")).toBe(true);
    expect(e.can(officer, "whatever")).toBe(true);
  });

  it("deny within a rule revokes a previously-allowed command", () => {
    const e = new RightsEngine({
      defaultAllow: ["play", "stop"],
      rules: [{ match: { serverGroups: ["100"] }, deny: ["stop"] }],
    });
    expect(e.can(member, "play")).toBe(true);
    expect(e.can(member, "stop")).toBe(false);
  });

  it("deny '*' clears the whole set", () => {
    const e = new RightsEngine({
      defaultAllow: ["play", "vote"],
      rules: [{ name: "muzzle", match: { uids: ["member-uid"] }, deny: ["*"] }],
    });
    expect(e.can(member, "play")).toBe(false);
    expect(e.can(officer, "play")).toBe(true); // rule didn't match officer
  });

  it("a rule with empty match applies to everyone", () => {
    const e = new RightsEngine({ rules: [{ match: {}, allow: ["help"] }] });
    expect(e.can(member, "help")).toBe(true);
    expect(e.can(officer, "help")).toBe(true);
  });

  it("later rules override earlier ones", () => {
    const e = new RightsEngine({
      rules: [
        { match: {}, allow: ["stop"] },
        { match: { serverGroups: ["100"] }, deny: ["stop"] },
      ],
    });
    expect(e.can(officer, "stop")).toBe(true); // only first rule matches
    expect(e.can(member, "stop")).toBe(false); // second rule revokes
  });

  it("is case-insensitive on command names", () => {
    const e = new RightsEngine({ defaultAllow: ["Play"] });
    expect(e.can(member, "play")).toBe(true);
    expect(e.can(member, "PLAY")).toBe(true);
  });

  it("reload swaps the ruleset atomically", () => {
    const e = new RightsEngine({ defaultAllow: ["play"] });
    expect(e.can(member, "stop")).toBe(false);
    e.reload({ defaultAllow: ["play", "stop"] });
    expect(e.can(member, "stop")).toBe(true);
  });

  it("scopes rules to the voice or chat surface (Grok salvage)", () => {
    const e = new RightsEngine({
      defaultAllow: ["play"],
      rules: [{ name: "voice-stop", match: { serverGroups: ["105"] }, allow: ["stop"], scope: "voice" }],
    });
    expect(e.can(officer, "stop", "voice")).toBe(true);
    expect(e.can(officer, "stop", "chat")).toBe(false);
    expect(e.can(officer, "stop")).toBe(false); // default context is chat
    // unscoped (both) rules still apply on every surface
    const e2 = new RightsEngine({ rules: [{ match: {}, allow: ["skip"] }] });
    expect(e2.can(member, "skip", "voice")).toBe(true);
    expect(e2.can(member, "skip", "chat")).toBe(true);
  });
});

describe("defaultRightsConfig", () => {
  it("grants public commands to everyone except analyst (gated to admins)", () => {
    const e = new RightsEngine(defaultRightsConfig([]));
    for (const cmd of PUBLIC_COMMANDS) {
      if (cmd === "analyst" || cmd === "agent") {
        expect(e.can(member, cmd)).toBe(false);
      } else {
        expect(e.can(member, cmd)).toBe(true);
      }
    }
    for (const cmd of ADMIN_COMMANDS) expect(e.can(member, cmd)).toBe(false);
  });

  it("grants admin and analyst commands to configured admin server-groups", () => {
    const e = new RightsEngine(defaultRightsConfig([105]));
    for (const cmd of ADMIN_COMMANDS) {
      expect(e.can(officer, cmd)).toBe(true); // officer in field-grade group
      expect(e.can(member, cmd)).toBe(false); // member in guest group
    }
    expect(e.can(officer, "analyst")).toBe(true);
    expect(e.can(officer, "agent")).toBe(true);
    expect(e.can(member, "analyst")).toBe(false);
    // public still works for the member
    expect(e.can(member, "play")).toBe(true);
  });
});

describe("RightsEngine — adversarial (no escalation, fail-safe)", () => {
  it("an unknown/unlisted command is denied by default", () => {
    const e = new RightsEngine(defaultRightsConfig([105]));
    expect(e.can(officer, "sudo")).toBe(false);
    expect(e.can(officer, "rm-rf")).toBe(false);
  });

  it("case tricks can't bypass a gate (normalized both ways)", () => {
    const e = new RightsEngine(defaultRightsConfig([105]));
    for (const v of ["STOP", "Stop", "sToP"]) expect(e.can(member, v)).toBe(false);
    for (const v of ["STOP", "Stop"]) expect(e.can(officer, v)).toBe(true);
  });

  it("a deny rule revokes even from an otherwise-privileged subject", () => {
    const e = new RightsEngine({
      ...defaultRightsConfig([6]),
      rules: [
        { name: "admins", match: { serverGroups: ["105"] }, allow: ["@admin"] },
        { name: "muzzle-officer", match: { uids: ["officer-uid"] }, deny: ["*"] },
      ],
    });
    expect(e.can(officer, "stop")).toBe(false); // muzzled despite admin group
    expect(e.can(officer, "play")).toBe(false); // deny * clears everything
  });

  it("a voice-scoped grant does NOT leak into chat (and vice versa)", () => {
    const e = new RightsEngine({
      rules: [{ match: { serverGroups: ["100"] }, allow: ["stop"], scope: "voice" }],
    });
    expect(e.can(member, "stop", "voice")).toBe(true);
    expect(e.can(member, "stop", "chat")).toBe(false); // no chat escalation
  });

  it("isRightsConfig accepts well-formed config and rejects garbage", () => {
    expect(isRightsConfig(defaultRightsConfig([6]))).toBe(true);
    expect(isRightsConfig({ rules: [{ match: { serverGroups: ["1"] }, allow: ["play"], scope: "voice" }] })).toBe(true);
    expect(isRightsConfig(null)).toBe(false);
    expect(isRightsConfig({ rules: "bad" })).toBe(false);
    expect(isRightsConfig({ rules: [{ allow: [1] }] })).toBe(false);
  });

  it("superAdmin bypass applies only to the exact listed uid", () => {
    const e = new RightsEngine({ defaultAllow: [], superAdminUids: ["owner-uid"] });
    expect(e.can(owner, "anything")).toBe(true);
    expect(e.can(officer, "anything")).toBe(false); // not the owner
  });
});
