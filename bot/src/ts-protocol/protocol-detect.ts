import net from "node:net";
import http from "node:http";

export type ServerProtocol = "ts3" | "ts6" | "unknown";

export interface ProtocolDetectResult {
  protocol: ServerProtocol;
  /** The query port that responded (10011 for TS3, 10080 for TS6 HTTP) */
  queryPort: number | null;
  /** Whether the voice port (UDP 9987) is the same for both */
  voicePort: number;
}

export interface DetectOptions {
  /** TS3 ServerQuery probe port (default: 10011) */
  ts3QueryPort?: number;
  /** TS6 HTTP Query probe port (default: 10080) */
  ts6HttpPort?: number;
}

/**
 * Probe a TeamSpeak server to determine if it's running TS3 or TS6.
 *
 * Detection strategy:
 *  1. Try TCP connect to port 10011 (TS3 ServerQuery) — if banner starts with "TS3", it's TS3.
 *  2. Try HTTP GET to port 10080 (TS6 HTTP Query) — if we get a valid HTTP response, it's TS6.
 *  3. If neither responds, return "unknown" (voice-only connection may still work).
 */
export async function detectServerProtocol(
  host: string,
  voicePort = 9987,
  timeoutMs = 3000,
  options?: DetectOptions,
): Promise<ProtocolDetectResult> {
  const ts3Port = options?.ts3QueryPort ?? 10011;
  const ts6Port = options?.ts6HttpPort ?? 10080;

  const [ts3, ts6] = await Promise.allSettled([
    probeTS3Query(host, ts3Port, timeoutMs),
    probeTS6HttpQuery(host, ts6Port, timeoutMs),
  ]);

  // Prefer TS3 if both somehow respond (shouldn't happen in practice)
  if (ts3.status === "fulfilled" && ts3.value) {
    return { protocol: "ts3", queryPort: ts3Port, voicePort };
  }
  if (ts6.status === "fulfilled" && ts6.value) {
    return { protocol: "ts6", queryPort: ts6Port, voicePort };
  }

  return { protocol: "unknown", queryPort: null, voicePort };
}

/**
 * Probe TS3 ServerQuery by connecting to raw TCP and checking for "TS3" banner.
 */
function probeTS3Query(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (value: boolean) => {
      if (resolved) return;
      resolved = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };

    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    let banner = "";
    const MAX_BANNER = 256; // TS3 banner is ~50 bytes; cap to avoid memory abuse

    socket.setTimeout(timeoutMs);

    socket.on("data", (data: Buffer) => {
      banner += data.toString("utf-8");
      if (banner.length > MAX_BANNER) banner = banner.slice(0, MAX_BANNER);
      if (banner.includes("TS3")) {
        done(true);
      }
    });

    socket.on("connect", () => {
      // Wait briefly for banner after TCP connect
      setTimeout(() => done(banner.includes("TS3")), 500);
    });

    socket.on("error", () => done(false));
    socket.on("timeout", () => done(false));
  });
}

/**
 * Probe TS6 HTTP Query by sending GET / and checking for a valid response.
 * Any HTTP status (including 401/403) confirms the TS6 HTTP Query exists.
 */
function probeTS6HttpQuery(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (value: boolean) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const req = http.request(
      {
        hostname: host,
        port,
        path: "/",
        method: "GET",
        timeout: timeoutMs,
        headers: { Accept: "application/json" },
      },
      (res) => {
        res.resume();
        done(res.statusCode !== undefined);
      },
    );

    req.on("error", () => done(false));
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });

    req.end();
  });
}
