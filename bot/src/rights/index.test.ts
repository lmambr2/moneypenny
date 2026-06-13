import { describe, it, expect } from "vitest";
import { RightsEngine, defaultRightsConfig, type Subject } from "./index.js";
import { PUBLIC_COMMANDS, ADMIN_COMMANDS } from "../bot/commands.js";

const member: Subject = { uid: "member-uid", serverGroups: ["8"] };
const officer: Subject = { uid: "officer-uid", serverGroups: ["6"] };
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
      rules: [{ name: "officers", match: { serverGroups: ["6"] }, allow: ["@admin"] }],
    });
    expect(e.can(officer, "stop")).toBe(true);
    expect(e.can(officer, "clear")).toBe(true);
    expect(e.can(member, "stop")).toBe(false); // member not in group 6
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
    const e = new RightsEngine({ rules: [{ match: { serverGroups: ["6"] }, allow: ["*"] }] });
    expect(e.can(officer, "stop")).toBe(true);
    expect(e.can(officer, "whatever")).toBe(true);
  });

  it("deny within a rule revokes a previously-allowed command", () => {
    const e = new RightsEngine({
      defaultAllow: ["play", "stop"],
      rules: [{ match: { serverGroups: ["8"] }, deny: ["stop"] }],
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
        { match: { serverGroups: ["8"] }, deny: ["stop"] },
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
});

describe("defaultRightsConfig", () => {
  it("grants all public commands to everyone and admin commands to no one without admin groups", () => {
    const e = new RightsEngine(defaultRightsConfig([]));
    for (const cmd of PUBLIC_COMMANDS) expect(e.can(member, cmd)).toBe(true);
    for (const cmd of ADMIN_COMMANDS) expect(e.can(member, cmd)).toBe(false);
  });

  it("grants admin commands to configured admin server-groups", () => {
    const e = new RightsEngine(defaultRightsConfig([6]));
    for (const cmd of ADMIN_COMMANDS) {
      expect(e.can(officer, cmd)).toBe(true); // officer in group "6"
      expect(e.can(member, cmd)).toBe(false); // member in group "8"
    }
    // public still works for the member
    expect(e.can(member, "play")).toBe(true);
  });
});

describe("Grok Build audit recs #4 + #6 (scopes + adversarial voice/cache proxy)", () => {
  it("voice-scoped allow does not grant the command over chat (adversarial cross-context)", () => {
    const e = new RightsEngine({
      defaultAllow: ["play"],
      rules: [
        { match: { serverGroups: ["6"] }, scope: "voice", allow: ["stop", "clear"] },
        { match: { serverGroups: ["6"] }, allow: ["vol"] }, // both by default
      ],
    });
    // voice context sees the scoped grant
    expect(e.can(officer, "stop", "voice")).toBe(true);
    expect(e.can(officer, "clear", "voice")).toBe(true);
    // chat (default) does not see voice-only grant; only the both rule + default
    expect(e.can(officer, "stop", "chat")).toBe(false);
    expect(e.can(officer, "stop")).toBe(false); // default context is chat
    expect(e.can(officer, "vol")).toBe(true);
    expect(e.can(member, "vol")).toBe(false);
  });

  it("cache-miss/low-priv synthetic subject (voice fallback proxy) gets only defaultAllow", () => {
    const e = new RightsEngine(defaultRightsConfig([6]));
    const low = { uid: "client:999", serverGroups: [] }; // what resolveVoice returns on total miss
    for (const cmd of PUBLIC_COMMANDS) expect(e.can(low, cmd)).toBe(true);
    for (const cmd of ADMIN_COMMANDS) expect(e.can(low, cmd)).toBe(false);
    // even officer groups wouldn't apply to this synthetic uid (no match)
    expect(e.can({ uid: "synthetic", serverGroups: ["6"] }, "stop")).toBe(false);
  });
});
