import { describe, expect, it, vi } from "vitest";
import { loadMcpConfig } from "./config.js";
import * as tools from "./tools.js";
import type { McpContext } from "./types.js";

function mockCtx(overrides?: Partial<McpContext>): McpContext {
  const bot = {
    id: "b1",
    getStatus: () => ({
      id: "b1",
      name: "Moneypenny",
      connected: true,
      playing: true,
      paused: false,
      currentSong: {
        id: "s1",
        name: "Test Track",
        artist: "Artist",
        album: "",
        platform: "local" as const,
        coverUrl: "",
        duration: 120,
      },
      queueSize: 2,
      volume: 50,
      playMode: "seq",
      elapsed: 10,
    }),
    getQueue: () => [
      {
        id: "s1",
        name: "A",
        artist: "X",
        album: "",
        platform: "local" as const,
        coverUrl: "",
        duration: 1,
      },
      {
        id: "s2",
        name: "B",
        artist: "Y",
        album: "",
        platform: "local" as const,
        coverUrl: "",
        duration: 1,
      },
    ],
    getRadioStatus: () => ({ enabled: false }),
    getRagStatus: async () => ({ configured: true, available: true, docCount: 3 }),
    listDoctrineDocs: () => [
      { source: "ops.md", classification: "unclassified", tags: [], chunks: 2, bytes: 10, updatedAt: 1 },
    ],
    getPlayHistoryRecords: (limit: number) =>
      [
        {
          songId: "s1",
          songName: "Past Track",
          artist: "A",
          album: "",
          platform: "local",
          playedAt: 100,
          coverUrl: "",
        },
      ].slice(0, limit),
    listHarnessTurns: (limit: number) =>
      [{ id: "h1", at: 1, user: "q", reply: "a", sources: [], tools: [], mode: "ask" as const }].slice(
        0,
        limit,
      ),
    executeRoutedCommand: vi.fn(async (cmd: { name: string }) => ({
      message: `ok:${cmd.name}`,
      denied: false,
    })),
    queryRag: vi.fn(async () => [{ text: "chunk", source: "doc.md", score: 0.9 }]),
    runHarnessTurn: vi.fn(async () => ({
      id: "h1",
      at: 1,
      user: "q",
      reply: "Answer from doctrine",
      sources: [{ source: "doc.md", text: "…" }],
      tools: [],
      mode: "ask" as const,
    })),
  };

  return {
    config: loadMcpConfig({ MCP_ENABLED: "1", MCP_TOKEN: "t" }),
    botManager: {
      getBot: (id: string) => (id === "b1" ? bot : undefined),
      getAllBots: () => [bot],
    } as any,
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as any,
    subject: {
      kind: "mcp",
      tokenId: "service",
      invokerUid: "mcp:service",
      invokerName: "grok-build",
      rightsProfile: "admin",
    },
    startedAt: Date.now(),
    requestId: "req-1",
    ...overrides,
  };
}

describe("MCP tools", () => {
  it("status_health lists bots", async () => {
    const env = await tools.statusHealth({}, mockCtx());
    expect(env.ok).toBe(true);
    expect((env.data as any).bots[0].id).toBe("b1");
  });

  it("status_now_playing returns current track", async () => {
    const env = await tools.statusNowPlaying({}, mockCtx());
    expect(env.ok).toBe(true);
    expect(env.code).toBe("OK");
    expect(env.meta.bot_id).toBe("b1");
    expect((env.data as any).current.title).toBe("Test Track");
  });

  it("status_queue respects limit", async () => {
    const env = await tools.statusQueue({ limit: 1 }, mockCtx());
    expect(env.ok).toBe(true);
    expect((env.data as any).items).toHaveLength(1);
  });

  it("music_play dispatches routed command", async () => {
    const ctx = mockCtx();
    const env = await tools.musicPlay({ query: "hello" }, ctx);
    expect(env.ok).toBe(true);
    expect(env.code).toBe("OK");
    expect(env.meta.bot_id).toBe("b1");
    const bot = ctx.botManager.getAllBots()[0] as any;
    expect(bot.executeRoutedCommand).toHaveBeenCalled();
    const cmd = bot.executeRoutedCommand.mock.calls[0][0];
    expect(cmd.name).toBe("play");
    expect(cmd.args).toContain("hello");
  });

  it("music_play dry_run skips dispatch", async () => {
    const ctx = mockCtx();
    const env = await tools.musicPlay({ query: "x", dry_run: true }, ctx);
    expect(env.ok).toBe(true);
    expect((env.data as any).dry_run).toBe(true);
    expect((ctx.botManager.getAllBots()[0] as any).executeRoutedCommand).not.toHaveBeenCalled();
  });

  it("readonly cannot play", async () => {
    const ctx = mockCtx({
      subject: {
        kind: "mcp",
        tokenId: "service",
        invokerUid: "mcp:service",
        invokerName: "ro",
        rightsProfile: "readonly",
      },
    });
    const env = await tools.musicPlay({ query: "x" }, ctx);
    expect(env.ok).toBe(false);
    expect(env.code).toBe("PERMISSION_DENIED");
  });

  it("rag_search returns chunks", async () => {
    const env = await tools.ragSearch({ q: "dock" }, mockCtx());
    expect(env.ok).toBe(true);
    expect((env.data as any).chunks).toHaveLength(1);
  });

  it("rag_ask returns reply", async () => {
    const env = await tools.ragAsk({ question: "where do we dock?" }, mockCtx());
    expect(env.ok).toBe(true);
    expect((env.data as any).reply).toContain("doctrine");
  });

  it("BOT_NOT_FOUND for bad bot_id", async () => {
    const env = await tools.statusNowPlaying({ bot_id: "missing" }, mockCtx());
    expect(env.ok).toBe(false);
    expect(env.code).toBe("BOT_NOT_FOUND");
  });

  // ─── Phase 2 ────────────────────────────────────────────────────────────

  it("music_stop dispatches !stop via routed command", async () => {
    const ctx = mockCtx();
    const env = await tools.musicStop({}, ctx);
    expect(env.ok).toBe(true);
    expect(env.code).toBe("OK");
    expect(env.meta.bot_id).toBe("b1");
    const bot = ctx.botManager.getAllBots()[0] as any;
    expect(bot.executeRoutedCommand.mock.calls[0][0].name).toBe("stop");
  });

  it("music_clear dispatches !clear", async () => {
    const ctx = mockCtx();
    const env = await tools.musicClear({}, ctx);
    expect(env.ok).toBe(true);
    expect((ctx.botManager.getAllBots()[0] as any).executeRoutedCommand.mock.calls[0][0].name).toBe(
      "clear",
    );
  });

  it("music_volume validates and dispatches !vol", async () => {
    const bad = await tools.musicVolume({ volume: 200 }, mockCtx());
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe("VALIDATION_ERROR");

    const ctx = mockCtx();
    const env = await tools.musicVolume({ volume: 42 }, ctx);
    expect(env.ok).toBe(true);
    const cmd = (ctx.botManager.getAllBots()[0] as any).executeRoutedCommand.mock.calls[0][0];
    expect(cmd.name).toBe("vol");
    expect(cmd.args).toBe("42");
  });

  it("music_mode dispatches valid modes and rejects garbage", async () => {
    expect((await tools.musicMode({ mode: "shuffle" }, mockCtx())).code).toBe("VALIDATION_ERROR");
    const ctx = mockCtx();
    const env = await tools.musicMode({ mode: "rloop" }, ctx);
    expect(env.ok).toBe(true);
    expect((ctx.botManager.getAllBots()[0] as any).executeRoutedCommand.mock.calls[0][0].args).toBe(
      "rloop",
    );
  });

  it("music_history returns play history envelope", async () => {
    const env = await tools.musicHistory({ limit: 10 }, mockCtx());
    expect(env.ok).toBe(true);
    expect((env.data as any).history[0].name).toBe("Past Track");
  });

  it("readonly denied on music_stop and doctrine_reindex", async () => {
    const ro = mockCtx({
      subject: {
        kind: "mcp",
        tokenId: "service",
        invokerUid: "mcp:service",
        invokerName: "ro",
        rightsProfile: "readonly",
      },
    });
    expect((await tools.musicStop({}, ro)).code).toBe("PERMISSION_DENIED");
    expect((await tools.doctrineReindex({}, ro)).code).toBe("PERMISSION_DENIED");
    expect((await tools.radioSet({ args: "on" }, ro)).code).toBe("PERMISSION_DENIED");
    expect((await tools.harnessTurns({}, ro)).code).toBe("PERMISSION_DENIED");
  });

  it("dj denied on admin-only stop but allowed on doctrine_list", async () => {
    const dj = mockCtx({
      subject: {
        kind: "mcp",
        tokenId: "service",
        invokerUid: "mcp:service",
        invokerName: "dj",
        rightsProfile: "dj",
      },
    });
    expect((await tools.musicStop({}, dj)).code).toBe("PERMISSION_DENIED");
    const list = await tools.doctrineList({}, dj);
    expect(list.ok).toBe(true);
    expect(list.code).toBe("OK");
    expect(list.meta.bot_id).toBe("b1");
    expect((list.data as any).docs[0].source).toBe("ops.md");
  });

  it("radio_set and doctrine_reindex dispatch routed commands", async () => {
    const ctx = mockCtx();
    expect((await tools.radioSet({ args: "on" }, ctx)).ok).toBe(true);
    expect((ctx.botManager.getAllBots()[0] as any).executeRoutedCommand.mock.calls[0][0].name).toBe(
      "radio",
    );
    expect((await tools.doctrineReindex({ sources: ["a.md"] }, ctx)).ok).toBe(true);
    const reindexCmd = (ctx.botManager.getAllBots()[0] as any).executeRoutedCommand.mock.calls[1][0];
    expect(reindexCmd.name).toBe("reindex");
    expect(reindexCmd.args).toContain("a.md");
  });

  it("doctrine_ingest_status and memory tools route commands", async () => {
    const ctx = mockCtx();
    expect((await tools.doctrineIngestStatus({}, ctx)).ok).toBe(true);
    expect((await tools.memoryRemember({ fact: "likes jazz" }, ctx)).ok).toBe(true);
    expect((await tools.memoryRecall({}, ctx)).ok).toBe(true);
    expect((await tools.memoryForget({ which: "1" }, ctx)).ok).toBe(true);
    const names = (ctx.botManager.getAllBots()[0] as any).executeRoutedCommand.mock.calls.map(
      (c: any[]) => c[0].name,
    );
    expect(names).toEqual(["ingeststatus", "remember", "recall", "forget"]);
  });

  it("harness_turns lists ring buffer", async () => {
    const env = await tools.harnessTurns({ limit: 5 }, mockCtx());
    expect(env.ok).toBe(true);
    expect((env.data as any).turns[0].id).toBe("h1");
  });
});
