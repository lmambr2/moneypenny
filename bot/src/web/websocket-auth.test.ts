import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import { WebSocketServer, WebSocket as WSClient } from "ws";
import { AddressInfo } from "node:net";
import { createDatabase, type BotDatabase } from "../data/database.js";
import { createUserStore } from "../data/users.js";
import { createSessionStore } from "../data/sessions.js";
import { validateSessionFromHeaders, SESSION_COOKIE_NAME } from "./auth/validateSession.js";

function buildServer(sessions: ReturnType<typeof createSessionStore>) {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => ws.send("hello"));
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") return socket.destroy();
    const r = validateSessionFromHeaders(req.headers.cookie as string | undefined, sessions);
    if (!r) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  return { server, wss };
}

describe("WebSocket auth at upgrade", () => {
  let botDb: BotDatabase;
  let httpServer: http.Server;
  let port: number;
  let validToken: string;

  beforeEach(async () => {
    botDb = createDatabase(":memory:");
    const users = createUserStore(botDb.db);
    const sessions = createSessionStore(botDb.db);
    const u = await users.createUser("alice", "pw-alice", "admin");
    validToken = sessions.createSession(u.id).token;

    const { server } = buildServer(sessions);
    httpServer = server;
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    botDb.close();
  });

  it("rejects upgrade without cookie (server-side close before open)", async () => {
    const ws = new WSClient(`ws://127.0.0.1:${port}/ws`);
    const result = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("opened"));
      ws.on("unexpected-response", (_req, res) => resolve(`status:${res.statusCode}`));
      ws.on("error", () => resolve("error"));
    });
    expect(result).toMatch(/^status:401$|^error$/);
  });

  it("accepts upgrade with a valid cookie", async () => {
    const ws = new WSClient(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${validToken}` },
    });
    const msg = await new Promise<string>((resolve, reject) => {
      ws.on("message", (data) => resolve(data.toString()));
      ws.on("error", reject);
    });
    expect(msg).toBe("hello");
    ws.close();
  });
});
