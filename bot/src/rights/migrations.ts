/**
 * Rights-config migrations. A deployment with a persisted custom ruleset
 * (config.rights) never sees shipped template updates — when a release adds
 * commands/tokens, live rulesets silently deny them (this is how `!radio` was
 * unrunnable for everyone, admins included, on the first radio deployment).
 *
 * Model: versioned, APPEND-ONLY deltas applied once at startup.
 *  - Append-only: we only ever add tokens to defaultAllow / commandGroups —
 *    nothing an admin granted or wrote is removed or reordered, and rules /
 *    superAdminUids are never touched.
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
      "radio", "rate", "unrate", "selecttracks",
      "playnext", "pn", "chevron7", "kg", "diary",
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
        applied.push(`(skipped group '${group}' — not present in live ruleset)`);
        continue;
      }
      for (const t of tokens) {
        if (!live.includes(t)) {
          live.push(t);
          applied.push(`@${group} += ${t}`);
        }
      }
    }
  }
  return { rights: out, version: CURRENT_RIGHTS_VERSION, applied };
}
