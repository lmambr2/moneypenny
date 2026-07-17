import { WebSocketServer } from "ws";
import { validateSessionFromHeaders } from "../../web/auth/validateSession.js";
import { setupWebSocket } from "../../web/websocket.js";
import type { HttpAppContext, HttpPlugin } from "../types.js";

/** Manual upgrade auth on /ws + player event fan-out. */
export const registerWebSocket: HttpPlugin = (ctx: HttpAppContext) => {
  const { server, options, sessions, logger, onStop } = ctx;

  const wss = new WebSocketServer({ noServer: true });
  wss.on("error", (err) => {
    logger.error({ err }, "WebSocket server error");
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") {
      socket.destroy();
      return;
    }
    const reqHost = req.headers.host;
    const originHeader = req.headers.origin;
    if (originHeader) {
      let originHost: string | null = null;
      try {
        originHost = new URL(originHeader).host;
      } catch {
        // fall through; treat as missing/invalid origin
      }
      if (!originHost || originHost !== reqHost) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    const result = validateSessionFromHeaders(req.headers.cookie as string | undefined, sessions);
    if (!result) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as unknown as { userId: string }).userId = result.userId;
      wss.emit("connection", ws, req);
    });
  });

  const cleanupWs = setupWebSocket(wss, options.botManager, logger);
  onStop.push(() => {
    cleanupWs();
    wss.close();
  });
};
