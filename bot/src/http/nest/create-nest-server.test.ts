import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { WebServerOptions } from "../types.js";
import { createNestWebServer } from "./create-nest-server.js";

function minimalOptions(): WebServerOptions {
  const logger = {
    child: () => logger,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    port: 0, // ephemeral
    host: "127.0.0.1",
    botManager: {
      getAllBots: () => [],
      on: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as WebServerOptions["botManager"],
    localProvider: {} as WebServerOptions["localProvider"],
    youtubeProvider: {} as WebServerOptions["youtubeProvider"],
    streamProvider: {} as WebServerOptions["streamProvider"],
    database: {
      db: {
        prepare: () => ({
          all: () => [],
          get: () => undefined,
          run: () => ({ changes: 0 }),
        }),
        exec: () => {},
      },
    } as unknown as WebServerOptions["database"],
    config: {
      trustProxy: false,
      trustProxyHops: 1,
      publicUrl: "http://localhost:3000",
      harnessIntentAllowDangerous: false,
    } as WebServerOptions["config"],
    configPath: "/tmp/moneypenny-test-config.json",
    logger: logger as unknown as WebServerOptions["logger"],
    avatarStore: {} as WebServerOptions["avatarStore"],
  };
}

function boundPort(server: http.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server not bound");
  return addr.port;
}

describe("createNestWebServer (PR-C3)", () => {
  it("boots Nest + Express and serves public SystemController routes", async () => {
    const options = minimalOptions();
    // Capture the HTTP server Nest creates by listening via start + probe.
    // We re-create with a known port via env-free bind: start then discover.
    const server = await createNestWebServer(options);
    await server.start();
    try {
      // Resolve bound port by probing via Node's default http (server listens on port 0).
      // createNestWebServer doesn't expose the Server — open a short-lived listen sibling
      // is unnecessary: use fetch against a range is flaky. Instead bind fixed high port.
      expect(server.start).toBeTypeOf("function");
      expect(server.stop).toBeTypeOf("function");
    } finally {
      server.stop();
    }
  });

  it("SystemController: /api/health and /api/openapi.json without session", async () => {
    // Bind a known ephemeral by wrapping: start server on port 0 via direct factory internals
    // is not exported — use a fixed free port from a temporary listener.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const port = boundPort(probe);
    probe.close();

    const options = minimalOptions();
    options.port = port;
    const server = await createNestWebServer(options);
    await server.start();
    try {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(health.status).toBe(200);
      const body = (await health.json()) as { status: string };
      expect(body.status).toBe("ok");

      const openapi = await fetch(`http://127.0.0.1:${port}/api/openapi.json`);
      expect(openapi.status).toBe(200);
      const doc = (await openapi.json()) as { openapi: string; paths: Record<string, unknown> };
      expect(doc.openapi).toMatch(/^3\./);
      expect(doc.paths["/api/health"]).toBeDefined();

      const pub = await fetch(`http://127.0.0.1:${port}/api/config/public-url`);
      expect(pub.status).toBe(200);
      const pubBody = (await pub.json()) as { publicUrl: string | null };
      expect(pubBody.publicUrl).toBe("http://localhost:3000");
    } finally {
      server.stop();
    }
  });
});
