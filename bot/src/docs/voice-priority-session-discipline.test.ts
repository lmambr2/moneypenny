import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isRightsConfig } from "../rights/index.js";
import { defaultVoiceConfig } from "../voice/types.js";

/**
 * Structural checks for the shipped ops doc + coexistence with permanent-rank
 * rights. Drives real files on disk (docs + rights template + defaultVoiceConfig),
 * not re-implemented strings.
 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const opsDocPath = `${repoRoot}/docs/voice-priority-session-discipline.md`;
const rankDocPath = `${repoRoot}/docs/rank-gating.md`;
const rightsPath = `${repoRoot}/scripts/rights-rank-gating.json`;

const SESSION_ROLES = [
  "Flight Lead / Captain",
  "Pilot",
  "Gunner / WSO",
  "Engineer / Comms (S-6)",
  "Wingman / Crew",
  "Guest",
] as const;

const CHANNEL_TYPES = [
  "Command / Captains",
  "Vehicle / Flight",
  "Squad / Wing",
  "Music / Moneypenny",
] as const;

describe("docs/voice-priority-session-discipline.md", () => {
  const doc = readFileSync(opsDocPath, "utf-8");
  const rankDoc = readFileSync(rankDocPath, "utf-8");

  it("names all six session-role groups", () => {
    for (const role of SESSION_ROLES) {
      expect(doc, `missing session role: ${role}`).toContain(role);
    }
  });

  it("requires temporary assign and clear after op (not sticky permanent ranks for voice)", () => {
    expect(doc).toMatch(/[Cc]lear temporary/);
    expect(doc).toMatch(/session start|Assign at session start/i);
    expect(doc).toMatch(/not sticky permanent ranks|Do not use permanent ranks as voice-priority/i);
  });

  it("defines the four channel types and the ~8–10 talker split rule", () => {
    for (const ch of CHANNEL_TYPES) {
      expect(doc, `missing channel type: ${ch}`).toContain(ch);
    }
    expect(doc).toMatch(/8–10|8-10/);
  });

  it("has S-6 ownership and start/end checklists with Priority Speaker / PTT / teardown", () => {
    expect(doc).toMatch(/Comms \/ S-6|S-6/);
    expect(doc).toMatch(/Start checklist/);
    expect(doc).toMatch(/End checklist/);
    expect(doc).toContain("Priority Speaker");
    expect(doc).toMatch(/[Ww]hisper lists?/);
    expect(doc).toContain("Channel Commander");
    expect(doc).toMatch(/PTT|multi-PTT|Default PTT/);
    expect(doc).toMatch(/Main net/);
    expect(doc).toMatch(/Secondary net/);
    expect(doc).toMatch(/Whisper to lead/);
  });

  it("keeps Moneypenny music ducking and defers stronger automation", () => {
    expect(doc).toContain("duckMusicOnSpeech");
    expect(doc).toMatch(/keep|Keep.*duck|ducking \(keep/i);
    expect(doc).toMatch(/deferred|stronger automation is deferred/i);
  });

  it("tags session roles with Session / prefix and documents !session clear + groupIds", () => {
    expect(doc).toContain("Session / Flight Lead");
    expect(doc).toContain("sessionRoles");
    expect(doc).toContain("groupIds");
    expect(doc).toContain("!session clear");
    expect(doc).toMatch(/autoClearOnEmpty/);
  });

  it("documents coexistence: permanent ranks remain rights source of truth", () => {
    expect(doc).toMatch(/Coexistence|permanent rank/i);
    expect(doc).toMatch(/RightsEngine|rights template|rights-rank-gating/);
    expect(doc).toMatch(/Must not|must not/);
    expect(rankDoc).toMatch(/Coexistence with session voice-priority roles/);
    expect(rankDoc).toContain("voice-priority-session-discipline.md");
    for (const role of ["Flight Lead / Captain", "Engineer / Comms (S-6)", "Wingman / Crew"]) {
      expect(rankDoc).toContain(role);
    }
  });
});

describe("permanent-rank rights template vs session roles", () => {
  const template = JSON.parse(readFileSync(rightsPath, "utf-8"));
  const templateText = readFileSync(rightsPath, "utf-8");

  it("is still a valid RightsConfig (no regression)", () => {
    expect(isRightsConfig(template)).toBe(true);
  });

  it("does not map rights solely from session-role name strings", () => {
    // Session roles are human labels; the shipped template uses numeric placeholder
    // permanent-rank group IDs only (e.g. "100".."114"), never Flight Lead etc.
    const sessionLabels = [
      "Flight Lead",
      "Gunner",
      "Wingman",
      "WSO",
      "Session /",
    ];
    for (const label of sessionLabels) {
      expect(templateText, `session label leaked into rights template: ${label}`).not.toContain(
        label,
      );
    }
    const rules = template.rules as Array<{ match?: { serverGroups?: string[] }; name?: string }>;
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const groups = rule.match?.serverGroups ?? [];
      for (const g of groups) {
        expect(String(g), `rule ${rule.name} should use numeric sgid placeholders`).toMatch(
          /^\d+$/,
        );
      }
    }
  });

  it("still includes permanent-rank style rule names (guest/cadet/…)", () => {
    const names = (template.rules as Array<{ name?: string }>).map((r) => r.name ?? "");
    expect(names).toEqual(expect.arrayContaining(["guest", "cadet", "command-staff", "server-admin"]));
  });
});

describe("Moneypenny music duck default (shipped code)", () => {
  it("defaultVoiceConfig enables duckMusicOnSpeech", () => {
    const v = defaultVoiceConfig();
    expect(v.duckMusicOnSpeech).toBe(true);
  });
});
