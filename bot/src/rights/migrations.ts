/**
 * Rights-config migrations. A deployment with a persisted custom ruleset
 * (config.rights) never sees shipped template updates — when a release adds
 * commands/tokens, live rulesets silently deny them (this is how `!radio` was
 * unrunnable for everyone, admins included, on the first radio deployment).
 *
 * Model: versioned, APPEND-ONLY deltas applied once at startup.
 *  - Append-only: we only ever add tokens to defaultAllow / commandGroups /
 *    existing rules' allow lists by name — nothing an admin granted or wrote
 *    is removed or reordered; superAdminUids are never touched; rules are
 *    never created/deleted/reordered.
 *  - Versioned (config.rightsSchemaVersion): each delta applies exactly once.
 *    If an admin deliberately removes a token afterwards, no later boot re-adds
 *    it. Fresh configs (no custom rights) skip straight to CURRENT_VERSION —
 *    the legacy default build derives from the live command manifest anyway.
 *  - Groups are extended only if they exist in the live ruleset; a group the
 *    admin deleted stays deleted (logged as skipped).
 */
import type { RightsConfig } from "./index.js";

interface RightsDelta {
  version: number;
  /** Commands appended to defaultAllow (member-level publics). */
  defaultAllow?: string[];
  /** Tokens appended per existing command group. */
  groups?: Record<string, string[]>;
  /**
   * Tokens appended to `rules[].allow` for rules whose `name` matches.
   * Never creates rules; never reorders or removes existing allow entries.
   */
  ruleAllowByName?: Record<string, string[]>;
}

/**
 * Shipped deltas, oldest first. Only ever append new versions — published
 * entries are immutable history.
 */
const DELTAS: readonly RightsDelta[] = [
  {
    // Radio mode (docs/radio.md §12), ratings, tag selection, and commands
    // that predated them but never reached frozen rulesets.
    version: 1,
    defaultAllow: [
      "radio",
      "rate",
      "unrate",
      "selecttracks",
      "playnext",
      "pn",
      "chevron7",
      "kg",
      "diary",
    ],
    groups: {
      dj: ["radio.ops", "radio.bumper", "radio.say", "radio.skip", "radio.tags"],
      admin: ["radio.power", "radio.ops", "radio.bumper", "radio.say", "radio.skip", "radio.tags"],
      analyst: ["intsum", "aar"],
    },
  },
  {
    version: 2,
    groups: {
      admin: ["radio.pin"],
    },
  },
  {
    // Org economy orders (docs/economy.md) — public seed calculators + UEX prices.
    version: 3,
    defaultAllow: ["mine", "refine", "craft", "econ"],
  },
  {
    // ACE-Step !generate (docs/ace-step.md A2) — DJ / admin only.
    version: 4,
    groups: {
      dj: ["generate"],
      admin: ["generate"],
    },
  },
  {
    // !ops org brief + external status (feature-roadmap G1/G2).
    version: 5,
    defaultAllow: ["ops"],
    groups: {
      dj: ["ops"],
      admin: ["ops"],
      analyst: ["ops"],
    },
  },
  {
    // G4 moderation + recording admin tokens.
    version: 6,
    groups: {
      admin: ["mute", "kick", "recording"],
      mod: ["mute", "kick"],
    },
  },
  {
    // !trade SC Trade Tools routes (docs/economy.md).
    version: 7,
    defaultAllow: ["trade"],
  },
  {
    // Org work-order shopping list.
    version: 8,
    defaultAllow: ["workorder", "work-items", "workitems"],
  },
  {
    // Clear-all work orders is destructive — admin only (aligns web dashboard).
    version: 9,
    groups: {
      admin: ["workorder.clear"],
    },
  },
  {
    // !test demo protect: only Chairman / server-admin may skip or clear it.
    // Not part of @admin — colonels keep clear for normal music but not the demo.
    version: 10,
    ruleAllowByName: {
      "server-admin": ["test.skip"],
      chairman: ["test.skip"],
    },
  },
];

export const CURRENT_RIGHTS_VERSION = DELTAS[DELTAS.length - 1].version;

export interface RightsMigrationResult {
  rights: RightsConfig | undefined;
  version: number;
  /** Human-readable additions, empty when nothing changed. */
  applied: string[];
}

/** Pure: apply all deltas newer than `fromVersion` to a custom ruleset. */
export function migrateRightsConfig(
  rights: RightsConfig | undefined,
  fromVersion: number,
): RightsMigrationResult {
  if (!rights || fromVersion >= CURRENT_RIGHTS_VERSION) {
    return { rights, version: CURRENT_RIGHTS_VERSION, applied: [] };
  }
  const out: RightsConfig = {
    ...rights,
    defaultAllow: [...(rights.defaultAllow ?? [])],
    commandGroups: Object.fromEntries(
      Object.entries(rights.commandGroups ?? {}).map(([k, v]) => [k, [...v]]),
    ),
    rules: (rights.rules ?? []).map((r) => ({
      ...r,
      allow: r.allow ? [...r.allow] : r.allow,
      deny: r.deny ? [...r.deny] : r.deny,
      match: r.match
        ? {
            ...r.match,
            uids: r.match.uids ? [...r.match.uids] : r.match.uids,
            serverGroups: r.match.serverGroups ? [...r.match.serverGroups] : r.match.serverGroups,
          }
        : r.match,
    })),
  };
  const applied: string[] = [];

  for (const delta of DELTAS) {
    if (delta.version <= fromVersion) continue;
    for (const cmd of delta.defaultAllow ?? []) {
      if (!out.defaultAllow!.includes(cmd)) {
        out.defaultAllow!.push(cmd);
        applied.push(`defaultAllow += ${cmd}`);
      }
    }
    for (const [group, tokens] of Object.entries(delta.groups ?? {})) {
      const live = out.commandGroups![group];
      if (!live) {
        // Never recreate a group the admin deleted. Do not put skips in
        // `applied` — re-running from version 0 must stay empty when the
        // ruleset is already fully migrated (idempotency).
        continue;
      }
      for (const t of tokens) {
        if (!live.includes(t)) {
          live.push(t);
          applied.push(`@${group} += ${t}`);
        }
      }
    }
    for (const [ruleName, tokens] of Object.entries(delta.ruleAllowByName ?? {})) {
      const rule = (out.rules ?? []).find((r) => r.name === ruleName);
      if (!rule) continue;
      if (!rule.allow) rule.allow = [];
      for (const t of tokens) {
        if (!rule.allow.includes(t)) {
          rule.allow.push(t);
          applied.push(`rule:${ruleName} += ${t}`);
        }
      }
    }
  }
  return { rights: out, version: CURRENT_RIGHTS_VERSION, applied };
}
