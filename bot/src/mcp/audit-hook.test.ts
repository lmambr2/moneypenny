import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createAuditStore } from "../data/audit.js";
import { recordMcpToolAudit } from "./audit-hook.js";
import { loadMcpConfig } from "./config.js";
import { runMcpTool, type McpMountOptions } from "./server.js";
import * as tools from "./tools.js";
import type { McpSubject } from "./types.js";

function subject(profile: McpSubject["rightsProfile"] = "admin"): McpSubject {
  return {
    kind: "mcp",
    tokenId: "service",
    invokerUid: "mcp:service",
    invokerName: "grok-build",
    rightsProfile: profile,
  };
}

function mockBot() {
  return {
    id: "b1",
    getStatus: () => ({
      id: "b1",
      name: "Bot",
      connected: true,
      playing: false,
      paused: false,
      currentSong: null,
      queueSize: 0,
      volume: 50,
      playMode: "seq",
      elapsed: 0,
    }),
    getQueue: () => [],
    getRadioStatus: () => ({ enabled: false }),
    getRagStatus: async () => ({}),
    listDoctrineDocs: () => [],
    getPlayHistoryRecords: () => [],
    listHarnessTurns: () => [],
    executeRoutedCommand: vi.fn(async (cmd: { name: string }) => ({
      message: `ok:${cmd.name}`,
      denied: false,
    })),
    queryRag: vi.fn(async () => []),
    runHarnessTurn: vi.fn(async () => ({
      id: "h1",
      at: 1,
      user: "q",
      reply: "a",
      sources: [],
      tools: [],
      mode: "ask" as const,
    })),
  };
}

function mountOpts(audit: ReturnType<typeof createAuditStore>, bot = mockBot()): McpMountOptions {
  return {
    mcpConfig: loadMcpConfig({ MCP_ENABLED: "1", MCP_TOKEN: "t" }),
    botManager: {
      getBot: (id: string) => (id === "b1" ? bot : undefined),
      getAllBots: () => [bot],
    } as any,
    config: {} as any,
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: () => ({ info: vi.fn() }) } as any,
    audit,
  };
}

describe("recordMcpToolAudit", () => {
  it("persists actor, tool name, bot id, and ok action", () => {
    const db = new Database(":memory:");
    // createAuditStore needs the user_audit table
    db.exec(`
      CREATE TABLE user_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        actorId TEXT,
        actorUsername TEXT,
        targetUserId TEXT,
        targetUsername TEXT,
        action TEXT NOT NULL
      );
    `);
    const audit = createAuditStore(db);
    recordMcpToolAudit(
      audit,
      subject(),
      "music_play",
      {
        ok: true,
        code: "OK",
        message: "Playing",
        data: null,
        meta: { bot_id: "b1", duration_ms: 3, request_id: "r1" },
      },
    );
    const row = db
      .prepare("SELECT actorId, actorUsername, targetUserId, targetUsername, action FROM user_audit")
      .get() as {
      actorId: string;
      actorUsername: string;
      targetUserId: string;
      targetUsername: string;
      action: string;
    };
    expect(row.action).toBe("mcp.tool");
    expect(row.actorId).toBe("mcp:service");
    expect(row.actorUsername).toContain("grok-build");
    expect(row.targetUserId).toBe("b1");
    expect(row.targetUsername).toBe("music_play");
  });

  it("records mcp.tool.denied for PERMISSION_DENIED envelopes", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE user_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        actorId TEXT,
        actorUsername TEXT,
        targetUserId TEXT,
        targetUsername TEXT,
        action TEXT NOT NULL
      );
    `);
    const audit = createAuditStore(db);
    recordMcpToolAudit(
      audit,
      subject("readonly"),
      "music_stop",
      {
        ok: false,
        code: "PERMISSION_DENIED",
        message: "nope",
        data: null,
        meta: { bot_id: "b1", duration_ms: 1, request_id: "r2" },
      },
    );
    const row = db.prepare("SELECT action FROM user_audit").get() as { action: string };
    expect(row.action).toBe("mcp.tool.denied");
  });

  it("no-ops when audit store is missing", () => {
    expect(() =>
      recordMcpToolAudit(undefined, subject(), "status_health", {
        ok: true,
        code: "OK",
        message: "ok",
        data: null,
        meta: { duration_ms: 0, request_id: "r" },
      }),
    ).not.toThrow();
  });
});

describe("runMcpTool (real handlers + audit)", () => {
  it("mutates via executeRoutedCommand and audits success", async () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE user_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        actorId TEXT,
        actorUsername TEXT,
        targetUserId TEXT,
        targetUsername TEXT,
        action TEXT NOT NULL
      );
    `);
    const audit = createAuditStore(db);
    const bot = mockBot();
    const opts = mountOpts(audit, bot);
    const result = await runMcpTool(opts, subject("admin"), "music_play", tools.musicPlay, {
      query: "hello world",
    });
    expect(result.envelope.ok).toBe(true);
    expect(result.envelope.code).toBe("OK");
    expect(result.envelope.meta.bot_id).toBe("b1");
    expect(bot.executeRoutedCommand).toHaveBeenCalled();
    const cmd = (bot.executeRoutedCommand as any).mock.calls[0][0];
    expect(cmd.name).toBe("play");

    const row = db
      .prepare("SELECT action, targetUsername, targetUserId FROM user_audit")
      .get() as { action: string; targetUsername: string; targetUserId: string };
    expect(row.action).toBe("mcp.tool");
    expect(row.targetUsername).toBe("music_play");
    expect(row.targetUserId).toBe("b1");
  });

  it("readonly music_stop is PERMISSION_DENIED and audits denied", async () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE user_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        actorId TEXT,
        actorUsername TEXT,
        targetUserId TEXT,
        targetUsername TEXT,
        action TEXT NOT NULL
      );
    `);
    const audit = createAuditStore(db);
    const bot = mockBot();
    const opts = mountOpts(audit, bot);
    const result = await runMcpTool(opts, subject("readonly"), "music_stop", tools.musicStop, {
      confirm: true,
    });
    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.code).toBe("PERMISSION_DENIED");
    expect(bot.executeRoutedCommand).not.toHaveBeenCalled();
    const row = db.prepare("SELECT action, targetUsername FROM user_audit").get() as {
      action: string;
      targetUsername: string;
    };
    expect(row.action).toBe("mcp.tool.denied");
    expect(row.targetUsername).toBe("music_stop");
  });
});
