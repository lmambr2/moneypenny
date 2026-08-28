/**
 * Temporary session-role server groups (voice priority / ops placement).
 *
 * Tag groups with the `Session /` name prefix on TeamSpeak and list their
 * numeric IDs in config.sessionRoles.groupIds. Moneypenny only ever strips
 * membership from that allowlist — never permanent rank groups used for rights.
 *
 * Docs: docs/voice-priority-session-discipline.md
 */

import type { TS6HttpQuery } from "@moneypenny/ts6-client";
import type { Logger } from "../../logger.js";

export const DEFAULT_SESSION_ROLE_NAME_PREFIX = "Session /";

export interface SessionRolesConfig {
  /**
   * TeamSpeak server-group IDs tagged temporary (e.g. Session / Flight Lead).
   * Empty → feature idle: !session status still works; clear is a no-op message.
   */
  groupIds: number[];
  /** Display / docs prefix. Default "Session /". */
  namePrefix: string;
  /**
   * When true, after the whole virtual server has 0 humans for clearGraceMinutes,
   * strip membership from groupIds. Off by default (S-6 uses !session clear).
   */
  autoClearOnEmpty: boolean;
  /** Minutes the server must stay empty before auto-clear. Default 15. */
  clearGraceMinutes: number;
}

export function defaultSessionRolesConfig(): SessionRolesConfig {
  return {
    groupIds: [],
    namePrefix: DEFAULT_SESSION_ROLE_NAME_PREFIX,
    autoClearOnEmpty: false,
    clearGraceMinutes: 15,
  };
}

/** Coerce config values to unique positive integer group IDs. */
export function normalizeSessionGroupIds(ids: unknown): number[] {
  if (!Array.isArray(ids)) return [];
  const out = new Set<number>();
  for (const raw of ids) {
    const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
    if (Number.isFinite(n) && n > 0) out.add(Math.trunc(n));
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Session clear may only touch allowlisted IDs that are **not** also used as
 * permanent-rank / rights groups. Intersection is blocked and reported.
 */
export function filterClearableSessionGroups(
  sessionIds: number[],
  permanentRankIds: Iterable<number | string>,
): { clearable: number[]; blocked: number[] } {
  const permanent = new Set(
    [...permanentRankIds]
      .map((x) => (typeof x === "number" ? x : Number.parseInt(String(x), 10)))
      .filter((n) => Number.isFinite(n) && n > 0)
      .map((n) => Math.trunc(n)),
  );
  const clearable: number[] = [];
  const blocked: number[] = [];
  for (const id of normalizeSessionGroupIds(sessionIds)) {
    if (permanent.has(id)) blocked.push(id);
    else clearable.push(id);
  }
  return { clearable, blocked };
}

/** Collect permanent-rank sgids from a rights ruleset + adminGroups. */
export function permanentRankIdsFromRights(
  rights: { rules?: Array<{ match?: { serverGroups?: string[] } }> } | undefined,
  adminGroups: Iterable<number | string> = [],
): number[] {
  const ids = new Set<number>();
  for (const g of adminGroups) {
    const n = typeof g === "number" ? g : Number.parseInt(String(g), 10);
    if (Number.isFinite(n) && n > 0) ids.add(Math.trunc(n));
  }
  for (const rule of rights?.rules ?? []) {
    for (const g of rule.match?.serverGroups ?? []) {
      const n = Number.parseInt(String(g), 10);
      if (Number.isFinite(n) && n > 0) ids.add(n);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/** Parse servergroupclientlist / similar Query body into client DB ids. */
export function parseServerGroupClientDbIds(body: unknown): number[] {
  const rows = normalizeQueryRows(body);
  const out = new Set<number>();
  for (const row of rows) {
    const raw = row.cldbid ?? row.client_database_id ?? row.cdb_id;
    const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
    if (Number.isFinite(n) && n > 0) out.add(Math.trunc(n));
  }
  return [...out];
}

/** Human clients from clientlist body (skip query type=1). */
export function countHumansFromClientListBody(body: unknown, botClid = 0): number {
  const rows = normalizeQueryRows(body);
  let n = 0;
  for (const row of rows) {
    const type = Number(row.client_type ?? row.type ?? 0);
    if (type === 1) continue;
    const clid = Number(row.clid ?? row.client_id ?? row.id ?? 0);
    if (botClid > 0 && clid === botClid) continue;
    n += 1;
  }
  return n;
}

export function formatSessionClearResult(opts: {
  dryRun: boolean;
  clearableGroups: number[];
  blockedGroups: number[];
  removed: number;
  memberships: number;
  errors: string[];
}): string {
  const { dryRun, clearableGroups, blockedGroups, removed, memberships, errors } = opts;
  if (clearableGroups.length === 0 && blockedGroups.length === 0) {
    return (
      "No temporary session-role groups configured. " +
      "Set sessionRoles.groupIds to the Session / … server-group IDs, then retry."
    );
  }
  if (clearableGroups.length === 0 && blockedGroups.length > 0) {
    return (
      `Refusing clear: every sessionRoles.groupId is also a permanent rights group ` +
      `(${blockedGroups.join(", ")}). Fix the allowlist — session tags must not reuse rank IDs.`
    );
  }
  const verb = dryRun ? "Would remove" : "Removed";
  const lines = [
    `${verb} ${removed} membership${removed === 1 ? "" : "s"} ` +
      `across ${clearableGroups.length} session group${clearableGroups.length === 1 ? "" : "s"} ` +
      `(${memberships} listed).`,
  ];
  if (blockedGroups.length > 0) {
    lines.push(
      `Skipped ${blockedGroups.length} id(s) also used for permanent rights: ${blockedGroups.join(", ")}.`,
    );
  }
  if (errors.length > 0) {
    lines.push(`Errors (${errors.length}): ${errors.slice(0, 5).join("; ")}`);
  }
  if (dryRun) lines.push("Dry run — no changes applied.");
  return lines.join(" ");
}

function normalizeQueryRows(body: unknown): Array<Record<string, unknown>> {
  if (body == null) return [];
  if (Array.isArray(body)) {
    return body.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  }
  if (typeof body === "object") {
    const o = body as Record<string, unknown>;
    // Common TS6 wrappers: { body: [...] }, { data: [...] }, single row object
    for (const key of ["body", "data", "clients", "rows"]) {
      if (Array.isArray(o[key])) return normalizeQueryRows(o[key]);
    }
    // Pipe-separated multi-row sometimes arrives as one object with array fields — treat as single
    return [o];
  }
  return [];
}

export interface SessionRolesDeps {
  getConfig: () => SessionRolesConfig;
  /** Permanent rank / rights group IDs that must never be stripped. */
  getPermanentRankIds: () => number[];
  getHttpQuery: () => TS6HttpQuery | null;
  /** Bot full-client clid when connected (excluded from empty-server count). */
  getBotClientId: () => number;
  isConnected: () => boolean;
  logger: Logger;
  /** Virtual server id for Query paths. Default 1. */
  sid?: number;
}

export class SessionRolesService {
  private emptySinceMs: number | null = null;
  private autoClearInFlight = false;
  private lastAutoClearAt = 0;

  constructor(private deps: SessionRolesDeps) {}

  static readonly USAGE =
    "Usage: !session [status|clear|clear dry] — temporary Session / role groups (S-6 / mod).";

  async handle(args: string, canRun?: (c: string) => boolean): Promise<string> {
    if (canRun && !canRun("session")) {
      return "You don't have permission for !session (needs 'session' — mod/admin via rights).";
    }
    const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const sub = parts[0] || "status";
    if (sub === "status" || sub === "list" || sub === "show") {
      return this.status();
    }
    if (sub === "clear" || sub === "end" || sub === "reset") {
      const dry =
        parts.includes("dry") ||
        parts.includes("dryrun") ||
        parts.includes("--dry") ||
        parts.includes("-n");
      return this.clear({ dryRun: dry });
    }
    return SessionRolesService.USAGE;
  }

  status(): string {
    const cfg = this.normalizeCfg(this.deps.getConfig());
    const { clearable, blocked } = filterClearableSessionGroups(
      cfg.groupIds,
      this.deps.getPermanentRankIds(),
    );
    const lines = [
      `Session roles (temporary): prefix "${cfg.namePrefix}"`,
      `Configured group IDs: ${cfg.groupIds.length ? cfg.groupIds.join(", ") : "(none — set sessionRoles.groupIds)"}`,
      `Clearable: ${clearable.length ? clearable.join(", ") : "—"}`,
    ];
    if (blocked.length) {
      lines.push(`Blocked (also permanent rights): ${blocked.join(", ")}`);
    }
    lines.push(
      `Auto-clear on empty server: ${cfg.autoClearOnEmpty ? `on (${cfg.clearGraceMinutes} min grace)` : "off"}`,
    );
    const q = this.deps.getHttpQuery();
    lines.push(`HTTP Query: ${q ? "available" : "unavailable (clear needs TS6 Query)"}`);
    return lines.join("\n");
  }

  async clear(opts: { dryRun?: boolean } = {}): Promise<string> {
    const dryRun = !!opts.dryRun;
    const cfg = this.normalizeCfg(this.deps.getConfig());
    const { clearable, blocked } = filterClearableSessionGroups(
      cfg.groupIds,
      this.deps.getPermanentRankIds(),
    );
    if (clearable.length === 0) {
      return formatSessionClearResult({
        dryRun,
        clearableGroups: clearable,
        blockedGroups: blocked,
        removed: 0,
        memberships: 0,
        errors: [],
      });
    }

    const query = this.deps.getHttpQuery();
    if (!query) {
      return (
        "Cannot clear session roles: TeamSpeak HTTP Query is not configured " +
        "(TS6_QUERY_HOST / API key). Configure Query or clear groups manually in the TS client."
      );
    }

    const sid = this.deps.sid ?? 1;
    let memberships = 0;
    let removed = 0;
    const errors: string[] = [];

    for (const sgid of clearable) {
      try {
        const list = await query.serverGroupClientList(sgid, sid);
        if (list.status < 200 || list.status >= 300) {
          errors.push(`sgid ${sgid} list HTTP ${list.status}`);
          continue;
        }
        const cldbids = parseServerGroupClientDbIds(list.body);
        memberships += cldbids.length;
        for (const cldbid of cldbids) {
          if (dryRun) {
            removed += 1;
            continue;
          }
          try {
            await query.serverGroupDelClient(sgid, cldbid, sid);
            removed += 1;
          } catch (err) {
            errors.push(
              `sgid ${sgid} cldbid ${cldbid}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err) {
        errors.push(`sgid ${sgid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.deps.logger.info(
      { dryRun, clearable, blocked, removed, memberships, errorCount: errors.length },
      "session-roles clear",
    );

    return formatSessionClearResult({
      dryRun,
      clearableGroups: clearable,
      blockedGroups: blocked,
      removed,
      memberships,
      errors,
    });
  }

  /**
   * Call from presence poll with **server-wide** human count (not music-channel only).
   * Schedules auto-clear when configured and the server stays empty for the grace period.
   */
  onServerHumanCount(humanCount: number): void {
    const cfg = this.normalizeCfg(this.deps.getConfig());
    if (!cfg.autoClearOnEmpty || cfg.groupIds.length === 0) {
      this.emptySinceMs = null;
      return;
    }
    if (humanCount > 0) {
      this.emptySinceMs = null;
      return;
    }
    const now = Date.now();
    if (this.emptySinceMs == null) this.emptySinceMs = now;
    const graceMs = Math.max(1, cfg.clearGraceMinutes) * 60_000;
    if (now - this.emptySinceMs < graceMs) return;
    // Cooldown so a failed clear does not spam every poll.
    if (this.autoClearInFlight || now - this.lastAutoClearAt < 60_000) return;
    this.autoClearInFlight = true;
    this.lastAutoClearAt = now;
    void this.clear({ dryRun: false })
      .then((msg) => {
        this.deps.logger.info({ msg }, "session-roles auto-clear on empty server");
        this.emptySinceMs = null;
      })
      .catch((err) => {
        this.deps.logger.warn({ err }, "session-roles auto-clear failed");
      })
      .finally(() => {
        this.autoClearInFlight = false;
      });
  }

  /** For tests: force empty-since clock. */
  _testSetEmptySince(ms: number | null): void {
    this.emptySinceMs = ms;
  }

  private normalizeCfg(raw: SessionRolesConfig): SessionRolesConfig {
    return {
      groupIds: normalizeSessionGroupIds(raw.groupIds),
      namePrefix:
        (raw.namePrefix || DEFAULT_SESSION_ROLE_NAME_PREFIX).trim() ||
        DEFAULT_SESSION_ROLE_NAME_PREFIX,
      autoClearOnEmpty: !!raw.autoClearOnEmpty,
      clearGraceMinutes:
        typeof raw.clearGraceMinutes === "number" && raw.clearGraceMinutes >= 0
          ? raw.clearGraceMinutes
          : 15,
    };
  }
}
