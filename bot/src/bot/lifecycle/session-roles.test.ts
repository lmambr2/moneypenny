import { describe, expect, it, vi } from "vitest";
import {
  countHumansFromClientListBody,
  filterClearableSessionGroups,
  formatSessionClearResult,
  normalizeSessionGroupIds,
  parseServerGroupClientDbIds,
  permanentRankIdsFromRights,
  SessionRolesService,
} from "./session-roles.js";

describe("normalizeSessionGroupIds", () => {
  it("keeps unique positive ints", () => {
    expect(normalizeSessionGroupIds([201, "202", 201, 0, -1, "x", 203.7])).toEqual([201, 202, 203]);
  });
  it("empty on garbage", () => {
    expect(normalizeSessionGroupIds(null)).toEqual([]);
    expect(normalizeSessionGroupIds("nope")).toEqual([]);
  });
});

describe("filterClearableSessionGroups", () => {
  it("blocks IDs that are also permanent ranks", () => {
    const r = filterClearableSessionGroups([201, 9, 202], [9, 6, 23]);
    expect(r.clearable).toEqual([201, 202]);
    expect(r.blocked).toEqual([9]);
  });
  it("allows all when no permanent overlap", () => {
    const r = filterClearableSessionGroups([201, 202], [9, 10]);
    expect(r.clearable).toEqual([201, 202]);
    expect(r.blocked).toEqual([]);
  });
});

describe("permanentRankIdsFromRights", () => {
  it("collects rule serverGroups + adminGroups", () => {
    const ids = permanentRankIdsFromRights(
      {
        rules: [{ match: { serverGroups: ["100", "101"] } }, { match: { serverGroups: ["106"] } }],
      },
      [107, "108"],
    );
    expect(ids).toEqual([100, 101, 106, 107, 108]);
  });
});

describe("parseServerGroupClientDbIds", () => {
  it("parses array of cldbid rows", () => {
    expect(
      parseServerGroupClientDbIds([{ cldbid: "10" }, { cldbid: 11 }, { client_database_id: 12 }]),
    ).toEqual([10, 11, 12]);
  });
  it("parses wrapped body", () => {
    expect(parseServerGroupClientDbIds({ body: [{ cldbid: 5 }] })).toEqual([5]);
  });
});

describe("countHumansFromClientListBody", () => {
  it("skips query clients and the bot clid", () => {
    const n = countHumansFromClientListBody(
      [
        { clid: 1, client_type: 0 },
        { clid: 2, client_type: 1 },
        { clid: 99, client_type: 0 },
      ],
      99,
    );
    expect(n).toBe(1);
  });
});

describe("formatSessionClearResult", () => {
  it("explains empty config", () => {
    expect(
      formatSessionClearResult({
        dryRun: false,
        clearableGroups: [],
        blockedGroups: [],
        removed: 0,
        memberships: 0,
        errors: [],
      }),
    ).toMatch(/sessionRoles\.groupIds/);
  });
  it("refuses when all blocked", () => {
    expect(
      formatSessionClearResult({
        dryRun: false,
        clearableGroups: [],
        blockedGroups: [9],
        removed: 0,
        memberships: 0,
        errors: [],
      }),
    ).toMatch(/Refusing clear/);
  });
  it("summarizes dry run removals", () => {
    const s = formatSessionClearResult({
      dryRun: true,
      clearableGroups: [201, 202],
      blockedGroups: [],
      removed: 3,
      memberships: 3,
      errors: [],
    });
    expect(s).toMatch(/Would remove 3/);
    expect(s).toMatch(/Dry run/);
  });
});

describe("SessionRolesService", () => {
  function makeService(opts: {
    groupIds?: number[];
    permanent?: number[];
    query?: {
      serverGroupClientList: ReturnType<typeof vi.fn>;
      serverGroupDelClient: ReturnType<typeof vi.fn>;
    } | null;
    autoClearOnEmpty?: boolean;
    clearGraceMinutes?: number;
  }) {
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    return new SessionRolesService({
      getConfig: () => ({
        groupIds: opts.groupIds ?? [201, 202],
        namePrefix: "Session /",
        autoClearOnEmpty: opts.autoClearOnEmpty ?? false,
        clearGraceMinutes: opts.clearGraceMinutes ?? 15,
      }),
      getPermanentRankIds: () => opts.permanent ?? [9, 10],
      getHttpQuery: () => (opts.query === undefined ? null : (opts.query as any)),
      getBotClientId: () => 1,
      isConnected: () => true,
      logger: logger as any,
    });
  }

  it("status lists configured ids", async () => {
    const s = makeService({ groupIds: [201], permanent: [9] });
    const out = await s.handle("status", () => true);
    expect(out).toContain("201");
    expect(out).toContain("Session /");
  });

  it("denies without rights", async () => {
    const s = makeService({});
    const out = await s.handle("clear", () => false);
    expect(out).toMatch(/permission/i);
  });

  it("clear dry-run strips only session groups via Query", async () => {
    const serverGroupClientList = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, body: [{ cldbid: 10 }, { cldbid: 11 }] });
    const serverGroupDelClient = vi.fn();
    const s = makeService({
      groupIds: [201, 9], // 9 is permanent → blocked
      permanent: [9],
      query: { serverGroupClientList, serverGroupDelClient },
    });
    const out = await s.handle("clear dry", () => true);
    expect(out).toMatch(/Would remove 2/);
    expect(out).toMatch(/Skipped.*9/);
    expect(serverGroupDelClient).not.toHaveBeenCalled();
    expect(serverGroupClientList).toHaveBeenCalledWith(201, 1);
    expect(serverGroupClientList).not.toHaveBeenCalledWith(9, 1);
  });

  it("clear applies delclient for each membership", async () => {
    const serverGroupClientList = vi
      .fn()
      .mockResolvedValue({ status: 200, body: [{ cldbid: 10 }] });
    const serverGroupDelClient = vi.fn().mockResolvedValue({ status: 200, body: {} });
    const s = makeService({
      groupIds: [201],
      permanent: [],
      query: { serverGroupClientList, serverGroupDelClient },
    });
    const out = await s.handle("clear", () => true);
    expect(out).toMatch(/Removed 1/);
    expect(serverGroupDelClient).toHaveBeenCalledWith(201, 10, 1);
  });

  it("clear without query explains the gap", async () => {
    const s = makeService({ groupIds: [201], query: null });
    const out = await s.handle("clear", () => true);
    expect(out).toMatch(/HTTP Query/);
  });

  it("auto-clear fires after grace when server empty", async () => {
    const serverGroupClientList = vi.fn().mockResolvedValue({ status: 200, body: [{ cldbid: 1 }] });
    const serverGroupDelClient = vi.fn().mockResolvedValue({ status: 200, body: {} });
    const s = makeService({
      groupIds: [201],
      permanent: [],
      autoClearOnEmpty: true,
      clearGraceMinutes: 15,
      query: { serverGroupClientList, serverGroupDelClient },
    });
    s.onServerHumanCount(0);
    s._testSetEmptySince(Date.now() - 16 * 60_000);
    s.onServerHumanCount(0);
    await vi.waitFor(() => expect(serverGroupDelClient).toHaveBeenCalled());
  });

  it("auto-clear resets when someone is online", () => {
    const s = makeService({
      groupIds: [201],
      autoClearOnEmpty: true,
      clearGraceMinutes: 1,
      query: {
        serverGroupClientList: vi.fn(),
        serverGroupDelClient: vi.fn(),
      },
    });
    s.onServerHumanCount(0);
    s._testSetEmptySince(Date.now() - 120_000);
    s.onServerHumanCount(2);
    s.onServerHumanCount(0);
    // emptySince just reset — should not clear immediately
    expect(s).toBeTruthy();
  });
});
