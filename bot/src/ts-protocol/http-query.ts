import http from "node:http";
import https from "node:https";

export interface HttpQueryOptions {
  host: string;
  port: number; // 10080 (HTTP) or 10443 (HTTPS)
  useTls?: boolean;
  apiKey?: string;
  timeoutMs?: number;
}

export interface HttpQueryResult {
  status: number;
  body: unknown;
}

/**
 * Thrown when the TS6 HTTP Query returns a non-2xx status.
 *
 * The previous implementation silently ignored the status code, so a 400
 * (bad parameter) or 403 (insufficient permission) looked identical to
 * success in logs. Callers that rely on the response being applied —
 * nickname / description / away-status updates — should catch this and
 * surface it rather than log "updated" for a request that was rejected.
 */
export class HttpQueryError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly path: string;

  constructor(path: string, status: number, body: unknown) {
    const bodySnippet = (() => {
      if (body == null) return "";
      const s = typeof body === "string" ? body : JSON.stringify(body);
      return s.length > 200 ? s.slice(0, 200) + "\u2026" : s;
    })();
    super(
      `TS6 HTTP Query ${path} failed: status=${status}${
        bodySnippet ? ` body=${bodySnippet}` : ""
      }`,
    );
    this.name = "HttpQueryError";
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

/**
 * TS6 HTTP Query client.
 *
 * TeamSpeak 6 Server replaces the TS3 raw-TCP ServerQuery (port 10011)
 * with an HTTP/HTTPS API on ports 10080/10443.
 *
 * Common endpoints (TS6 HTTP Query):
 *   GET  /                         → server info / health check
 *   POST /api-key                  → create API key
 *   GET  /1/serverlist             → list virtual servers
 *   GET  /1/clientlist?sid={sid}   → list clients
 *   POST /1/sendtextmessage        → send text message
 *   POST /1/clientmove             → move a client
 *   GET  /1/channellist?sid={sid}  → list channels
 *   POST /1/clientupdate           → update client properties
 */
export class TS6HttpQuery {
  private options: Required<HttpQueryOptions>;

  constructor(options: HttpQueryOptions) {
    this.options = {
      host: options.host,
      port: options.port,
      useTls: options.useTls ?? options.port === 10443,
      apiKey: options.apiKey ?? "",
      timeoutMs: options.timeoutMs ?? 5000,
    };
  }

  async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<HttpQueryResult> {
    const { host, port, useTls, apiKey, timeoutMs } = this.options;
    const transport = useTls ? https : http;

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (apiKey) {
      headers["x-api-key"] = apiKey;
    }

    let bodyStr: string | undefined;
    if (body) {
      bodyStr = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const req = transport.request(
        {
          hostname: host,
          port,
          path,
          method,
          timeout: timeoutMs,
          headers,
          rejectUnauthorized: false, // self-signed certs common on self-hosted
        },
        (res) => {
          let data = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk: string) => (data += chunk));
          res.on("error", fail);
          res.on("end", () => {
            if (settled) return;
            settled = true;
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = data;
            }
            resolve({
              status: res.statusCode ?? 0,
              body: parsed,
            });
          });
        },
      );

      req.on("error", fail);
      req.on("timeout", () => {
        req.destroy();
        fail(new Error("TS6 HTTP Query timeout"));
      });

      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  /** Check if the TS6 HTTP Query is reachable */
  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.request("GET", "/");
      return result.status >= 200 && result.status < 500;
    } catch {
      return false;
    }
  }

  /** List virtual servers */
  async serverList(): Promise<HttpQueryResult> {
    return this.request("GET", "/1/serverlist");
  }

  /** List clients on a virtual server */
  async clientList(sid = 1): Promise<HttpQueryResult> {
    return this.request("GET", `/1/clientlist?sid=${sid}`);
  }

  /** List channels on a virtual server */
  async channelList(sid = 1): Promise<HttpQueryResult> {
    return this.request("GET", `/1/channellist?sid=${sid}`);
  }

  /** Send a text message */
  async sendTextMessage(
    targetMode: number,
    target: number,
    msg: string,
    sid = 1,
  ): Promise<HttpQueryResult> {
    return this.request("POST", `/1/sendtextmessage?sid=${sid}`, {
      targetmode: targetMode,
      target,
      msg,
    });
  }

  /**
   * Update client properties (e.g., description, nickname, away).
   *
   * Throws HttpQueryError on non-2xx responses. The TS6 server returns
   * 400 for invalid parameters and 403 for insufficient permissions;
   * prior to this check the errors were silently dropped and callers
   * logged a false "updated" success.
   */
  async clientUpdate(
    properties: Record<string, string | number>,
    sid = 1,
  ): Promise<HttpQueryResult> {
    const path = `/1/clientupdate?sid=${sid}`;
    const result = await this.request("POST", path, properties);
    if (result.status < 200 || result.status >= 300) {
      throw new HttpQueryError(path, result.status, result.body);
    }
    return result;
  }

  /** Move a client to a channel */
  async clientMove(
    clid: number,
    cid: number,
    cpw?: string,
    sid = 1,
  ): Promise<HttpQueryResult> {
    const body: Record<string, unknown> = { clid, cid };
    if (cpw) body.cpw = cpw;
    return this.request("POST", `/1/clientmove?sid=${sid}`, body);
  }
}
