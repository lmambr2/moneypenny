import { PUBLIC_COMMANDS, ADMIN_COMMANDS } from "../bot/commands.js";

/**
 * Rank-gating rights model (DESIGN §8).
 *
 * A declarative, group-aware replacement for the flat PUBLIC/ADMIN command
 * sets, reimplemented in spirit (not source) from TS3AudioBot's Rights system:
 * ordered rules match on client UID or TeamSpeak server-group, and grant/revoke
 * commands. Mapping rules to the server's military-rank server-groups makes
 * command access follow the rank hierarchy. Config-driven and hot-reloadable
 * via `reload()`.
 */

/** The acting user, resolved from the inbound message + TS client info. */
export interface Subject {
  uid: string;
  /** Server-group IDs the user belongs to, as strings (ClientInfo.serverGroups). */
  serverGroups: string[];
  nickname?: string;
}

export interface RightsRule {
  /** Optional label for logging / debugging. */
  name?: string;
  /**
   * Match criteria (any-of). A rule with no criteria matches every subject —
   * useful for a global allow/deny baseline.
   */
  match: {
    uids?: string[];
    serverGroups?: string[];
  };
  /** Commands to grant. Tokens: a command name, "@groupName", or "*" (all). */
  allow?: string[];
  /** Commands to revoke (applied after allow within the same rule). */
  deny?: string[];
}

export interface RightsConfig {
  /** Commands everyone may run before any rule applies. Supports "@group"/"*". */
  defaultAllow?: string[];
  /** Named command sets, referenced as "@name" in allow/deny. */
  commandGroups?: Record<string, string[]>;
  /** UIDs that bypass every check (server owner / maintainer). */
  superAdminUids?: string[];
  /** Ordered rules; later rules override earlier ones. */
  rules?: RightsRule[];
}

export class RightsEngine {
  private config: RightsConfig;

  constructor(config: RightsConfig = {}) {
    this.config = config;
  }

  /** Hot-reload the ruleset (atomic swap; no restart needed). */
  reload(config: RightsConfig): void {
    this.config = config;
  }

  /** Whether `subject` may run `command`. */
  can(subject: Subject, command: string): boolean {
    if (this.isSuperAdmin(subject)) return true;
    const allowed = this.computeAllowed(subject);
    return allowed.has("*") || allowed.has(command.toLowerCase());
  }

  /** The full set of commands a subject may run (groups expanded, rules applied). */
  computeAllowed(subject: Subject): Set<string> {
    const set = new Set<string>();
    this.applyAllow(set, this.config.defaultAllow);
    for (const rule of this.config.rules ?? []) {
      if (!this.matches(rule, subject)) continue;
      this.applyAllow(set, rule.allow);
      this.applyDeny(set, rule.deny);
    }
    return set;
  }

  private isSuperAdmin(subject: Subject): boolean {
    return (this.config.superAdminUids ?? []).includes(subject.uid);
  }

  private matches(rule: RightsRule, subject: Subject): boolean {
    const { uids, serverGroups } = rule.match ?? {};
    const hasUids = !!uids && uids.length > 0;
    const hasGroups = !!serverGroups && serverGroups.length > 0;
    // No criteria → global rule, matches everyone.
    if (!hasUids && !hasGroups) return true;
    if (hasUids && uids!.includes(subject.uid)) return true;
    if (hasGroups && serverGroups!.some((g) => subject.serverGroups.includes(g))) return true;
    return false;
  }

  /** Expand a token to concrete command names ("*" stays as the literal "*"). */
  private expand(token: string): string[] {
    if (token === "*") return ["*"];
    if (token.startsWith("@")) {
      const group = this.config.commandGroups?.[token.slice(1)] ?? [];
      return group.map((c) => c.toLowerCase());
    }
    return [token.toLowerCase()];
  }

  private applyAllow(set: Set<string>, tokens?: string[]): void {
    for (const t of tokens ?? []) {
      for (const c of this.expand(t)) set.add(c);
    }
  }

  private applyDeny(set: Set<string>, tokens?: string[]): void {
    for (const t of tokens ?? []) {
      if (t === "*") {
        set.clear();
        continue;
      }
      for (const c of this.expand(t)) set.delete(c);
    }
  }
}

/**
 * Build a sensible default ruleset that preserves the legacy public/admin
 * split: everyone gets the public commands; the configured admin server-groups
 * additionally get the admin commands. With no admin groups configured, admin
 * commands are denied to everyone — set `adminGroups` (or custom rules) to grant
 * them. ("ask" is included in PUBLIC_COMMANDS, so Q&A is public by default.)
 */
export function defaultRightsConfig(adminGroups: number[] = []): RightsConfig {
  return {
    defaultAllow: [...PUBLIC_COMMANDS],
    commandGroups: { admin: [...ADMIN_COMMANDS] },
    superAdminUids: [],
    rules:
      adminGroups.length > 0
        ? [{ name: "admins", match: { serverGroups: adminGroups.map(String) }, allow: ["@admin"] }]
        : [],
  };
}
