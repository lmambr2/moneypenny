import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { loadMcpConfig } from "./config.js";
import { createMcpRouter, MCP_TOOL_NAMES } from "./server.js";

describe("MCP HTTP mount", () => {
  it("rejects missing bearer", async () => {
    const mcpConfig = loadMcpConfig({
      MCP_ENABLED: "1",
      MCP_TOKEN: "secret-token",
    });
    const app = express();
    app.use(
      "/mcp",
      express.json(),
      createMcpRouter({
        mcpConfig,
        botManager: { getAllBots: () => [], getBot: () => undefined } as any,
        config: {} as any,
        logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: () => ({ info: vi.fn(), error: vi.fn() }) } as any,
      }),
    );

    const res = await request(app).post("/mcp").send({ jsonrpc: "2.0", method: "ping", id: 1 });
    expect(res.status).toBe(401);
  });

  it("accepts valid bearer and answers initialize", async () => {
    const mcpConfig = loadMcpConfig({
      MCP_ENABLED: "1",
      MCP_TOKEN: "secret-token",
    });
    const app = express();
    app.use(
      "/mcp",
      express.json(),
      createMcpRouter({
        mcpConfig,
        botManager: {
          getAllBots: () => [
            {
              id: "b1",
              getStatus: () => ({
                id: "b1",
                name: "Bot",
                connected: false,
                playing: false,
                paused: false,
                currentSong: null,
                queueSize: 0,
                volume: 50,
                playMode: "seq",
                elapsed: 0,
              }),
            },
          ],
          getBot: () => undefined,
        } as any,
        config: {} as any,
        logger: {
          info: vi.fn(),
          error: vi.fn(),
          warn: vi.fn(),
          child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
        } as any,
      }),
    );

    const res = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer secret-token")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.0.1" },
        },
      });

    // Streamable HTTP may return 200 with JSON or SSE depending on Accept.
    expect([200, 202]).toContain(res.status);
    const body = typeof res.text === "string" ? res.text : JSON.stringify(res.body);
    expect(body.toLowerCase()).toMatch(/moneypenny|serverinfo|protocol|result|initialize/);
  });

  it("registers Phase-2/3 operator tool names", () => {
    for (const name of [
      "music_stop",
      "music_clear",
      "music_volume",
      "music_mode",
      "music_history",
      "radio_set",
      "doctrine_list",
      "doctrine_reindex",
      "doctrine_ingest_status",
      "memory_remember",
      "memory_recall",
      "memory_forget",
      "harness_turns",
      "econ_run",
      "workorder_run",
      "work_items",
      "generate_music",
      "mod_mute",
      "mod_kick",
    ]) {
      expect(MCP_TOOL_NAMES).toContain(name);
    }
    expect(MCP_TOOL_NAMES).not.toContain("run_command");
    expect(MCP_TOOL_NAMES).not.toContain("exec");
    expect(MCP_TOOL_NAMES).not.toContain("settings_patch");
  });
});
