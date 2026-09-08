/**
 * Bot-owned PersonaPlex adapter client (K8).
 * HTTP /health + POST /v1/control; binary WS /v1/pcm.
 * Adapter protocol — not official Moshi 0x01=Opus. Inbound 0x02 is forbidden.
 */

import { WebSocket } from "ws";
import { fetchJson } from "../util/http.js";
import {
  type DuplexHealth,
  healthUnreachable,
  parseDuplexHealth,
  TALKER_VRAM_IDLE_MB,
  UNLOAD_TIMEOUT_MS,
} from "./duplex-watch.js";

export const KIND_PCM = 0x01;
export const KIND_TEXT = 0x02;
export const KIND_CONTROL = 0x03;
export const KIND_META = 0x04;

export type DuplexControlOp = "prompt" | "voice" | "reset" | "mute_out" | "unload" | "warm";

export interface DuplexControl {
  op: DuplexControlOp;
  [k: string]: unknown;
}

export interface DuplexPcmHandlers {
  onPcm?: (pcm: Buffer) => void;
  /** Agent inner monologue — captions / speaking-gate only. Never skip-LLM. */
  onAgentText?: (text: string) => void;
  onMeta?: (meta: Record<string, unknown>) => void;
  onClose?: () => void;
}

export class DuplexClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  wsUrl(): string {
    const u = new URL(this.baseUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = `${u.pathname.replace(/\/$/, "")}/v1/pcm`;
    return u.toString();
  }

  async health(timeoutMs = 3000): Promise<DuplexHealth> {
    try {
      const raw = await fetchJson<unknown>(`${this.baseUrl}/health`, { timeoutMs });
      return parseDuplexHealth(raw);
    } catch {
      return healthUnreachable();
    }
  }

  async control(body: DuplexControl, timeoutMs = UNLOAD_TIMEOUT_MS): Promise<DuplexHealth> {
    const raw = await fetchJson<unknown>(`${this.baseUrl}/v1/control`, {
      method: "POST",
      timeoutMs,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return parseDuplexHealth(raw);
  }

  async unload(): Promise<DuplexHealth> {
    return this.control({ op: "unload" });
  }

  async warm(): Promise<DuplexHealth> {
    return this.control({ op: "warm" });
  }

  async muteOut(): Promise<DuplexHealth> {
    return this.control({ op: "mute_out" });
  }

  /** Poll until weights are gone or timeout. Never hang D2 on GPU Whisper. */
  async waitUnloaded(timeoutMs = UNLOAD_TIMEOUT_MS): Promise<DuplexHealth> {
    const deadline = Date.now() + timeoutMs;
    let last = await this.health();
    while (Date.now() < deadline) {
      if (
        last.ok &&
        last.loaded === false &&
        (last.vram_mb === undefined || last.vram_mb <= TALKER_VRAM_IDLE_MB)
      ) {
        return last;
      }
      await new Promise((r) => setTimeout(r, 100));
      last = await this.health();
    }
    return last;
  }

  connectPcm(handlers: DuplexPcmHandlers = {}): DuplexPcmSession {
    return new DuplexPcmSession(this.wsUrl(), handlers);
  }
}

export class DuplexPcmSession {
  private ws: WebSocket;
  private ready: Promise<void>;

  constructor(url: string, handlers: DuplexPcmHandlers) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "nodebuffer";
    this.ready = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (buf.length < 1) return;
      const kind = buf[0];
      const payload = buf.subarray(1);
      if (kind === KIND_PCM) handlers.onPcm?.(payload);
      else if (kind === KIND_TEXT) handlers.onAgentText?.(payload.toString("utf8"));
      else if (kind === KIND_META) {
        try {
          const meta = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
          handlers.onMeta?.(meta);
        } catch {
          /* ignore malformed meta */
        }
      }
    });
    this.ws.on("close", () => handlers.onClose?.());
  }

  async waitOpen(): Promise<void> {
    await this.ready;
  }

  sendPcm(pcm: Buffer): void {
    this.ws.send(Buffer.concat([Buffer.from([KIND_PCM]), pcm]));
  }

  sendControl(body: DuplexControl): void {
    const json = Buffer.from(JSON.stringify(body), "utf8");
    this.ws.send(Buffer.concat([Buffer.from([KIND_CONTROL]), json]));
  }

  close(): void {
    this.ws.close();
  }
}

export { type DuplexHealth, parseDuplexHealth } from "./duplex-watch.js";
