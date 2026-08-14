import { ADMIN_COMMANDS, PUBLIC_COMMANDS } from "../bot/commands.js";

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
  /**
   * Optional surface this rule applies to: "voice" or "chat" scopes it to only
   * that path; "both" (the default when omitted) applies everywhere. Lets you
   * grant/deny a command for spoken commands without touching typed chat (or vice
   * versa) — e.g. allow `stop` by voice in-channel but require typing it in chat.

   */
  scope?: "voice" | "chat" | "both";
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

  /** Whether `subject` may run `command`. `context` gates voice-/chat-scoped rules (default chat). */
  can(subject: Subject, command: string, context: "voice" | "chat" = "chat"): boolean {
    if (this.isSuperAdmin(subject)) return true;
    const allowed = this.computeAllowed(subject, context);
    return allowed.has("*") || allowed.has(command.toLowerCase());
  }

  /** The full set of commands a subject may run (groups expanded, rules applied, scope-filtered). */
  computeAllowed(subject: Subject, context: "voice" | "chat" = "chat"): Set<string> {
    const set = new Set<string>();
    this.applyAllow(set, this.config.defaultAllow);
    for (const rule of this.config.rules ?? []) {
      if (!this.matches(rule, subject)) continue;
      // A scoped rule applies only on its surface; "both"/undefined applies everywhere.
      if (rule.scope && rule.scope !== "both" && rule.scope !== context) continue;
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
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Runtime validation for admin-submitted rights JSON (Settings advanced mode). */
export function isRightsConfig(v: unknown): v is RightsConfig {
  if (v === null || v === undefined) return false;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (o.defaultAllow !== undefined && !isStringArray(o.defaultAllow)) return false;
  if (o.superAdminUids !== undefined && !isStringArray(o.superAdminUids)) return false;
  if (o.commandGroups !== undefined) {
    if (
      typeof o.commandGroups !== "object" ||
      o.commandGroups === null ||
      Array.isArray(o.commandGroups)
    )
      return false;
    for (const val of Object.values(o.commandGroups)) {
      if (!isStringArray(val)) return false;
    }
  }
  if (o.rules !== undefined) {
    if (!Array.isArray(o.rules)) return false;
    for (const rule of o.rules) {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false;
      const r = rule as RightsRule;
      if (r.name !== undefined && typeof r.name !== "string") return false;
      if (r.match !== undefined) {
        if (typeof r.match !== "object" || r.match === null || Array.isArray(r.match)) return false;
        if (r.match.uids !== undefined && !isStringArray(r.match.uids)) return false;
        if (r.match.serverGroups !== undefined && !isStringArray(r.match.serverGroups))
          return false;
      }
      if (r.allow !== undefined && !isStringArray(r.allow)) return false;
      if (r.deny !== undefined && !isStringArray(r.deny)) return false;
      if (r.scope !== undefined && r.scope !== "voice" && r.scope !== "chat" && r.scope !== "both")
        return false;
    }
  }
  return true;
}

/** Commands gated separately from the public set (DESIGN §R1 — analyst delegation). */
const ANALYST_COMMANDS = ["analyst", "agent", "intsum", "aar"] as const;
/** ACE-Step — @dj in the rank-gating template; fallback ruleset has no DJ group. */
const DJ_COMMANDS = ["generate"] as const;

export function defaultRightsConfig(adminGroups: number[] = []): RightsConfig {
  const gated = new Set<string>([...ANALYST_COMMANDS, ...DJ_COMMANDS]);
  const publicDefault = [...PUBLIC_COMMANDS]
    .map((c) => c.toLowerCase())
    .filter((c) => !gated.has(c));
  return {
    defaultAllow: publicDefault,
    commandGroups: {
      admin: [...ADMIN_COMMANDS, ...DJ_COMMANDS].map((c) => c.toLowerCase()),
      analyst: [...ANALYST_COMMANDS],
    },
    superAdminUids: [],
    rules:
      adminGroups.length > 0
        ? [
            {
              name: "admins",
              match: { serverGroups: adminGroups.map(String) },
              allow: ["@admin", "@analyst"],
            },
          ]
        : [],
  };
}
