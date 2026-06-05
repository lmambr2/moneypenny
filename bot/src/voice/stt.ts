import axios from "axios";
import type { Logger } from "../logger.js";
import type { SttProvider, Utterance } from "./types.js";

/**
 * Speech-to-text client for a sherpa-onnx HTTP sidecar (DESIGN §10).
 *
 * sherpa-onnx itself is a library; this targets a thin HTTP server around it
 * that accepts raw 16-bit PCM (with sample-rate/channel headers) and returns
 * `{ text }`. Kept behind the SttProvider interface so the transport can change
 * (local socket, in-process binding) without touching the pipeline.
 *
 * NOTE: requires the sidecar to be running; unvalidated against real hardware.
 */
export class SherpaSttClient implements SttProvider {
  private url: string;
  private logger?: Logger;
  private timeoutMs: number;

  constructor(opts: { url: string; logger?: Logger; timeoutMs?: number }) {
    this.url = opts.url.replace(/\/$/, "");
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async transcribe(u: Utterance): Promise<string> {
    try {
      const { data } = await axios.post(`${this.url}/asr`, u.pcm, {
        timeout: this.timeoutMs,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Sample-Rate": String(u.sampleRate),
          "X-Channels": String(u.channels),
        },
        // PCM is binary; don't let axios try to JSON-encode it.
        responseType: "json",
        maxBodyLength: Infinity,
      });
      const text = typeof data?.text === "string" ? data.text.trim() : "";
      this.logger?.debug({ chars: text.length }, "STT transcribed utterance");
      return text;
    } catch (err: any) {
      this.logger?.warn({ err: err?.message, url: this.url }, "STT request failed");
      return "";
    }
  }
}
