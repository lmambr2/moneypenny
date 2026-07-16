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
    executeRoutedCommand: vi.fn(async () => ({ message: "Playing Test Track", denied: false })),
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
});
