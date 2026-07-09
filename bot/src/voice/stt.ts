import axios from "axios";
import type { Logger } from "../logger.js";
import { errorMessage } from "../util/error.js";
import type { SttProvider, StreamSttResult, Utterance } from "./types.js";

function streamErrorDetail(err: unknown): string | undefined {
  if (!axios.isAxiosError(err)) return undefined;
  const data = err.response?.data;
  if (typeof data === "string" && data.trim()) return data.trim();
  if (data && typeof data === "object" && "error" in data) {
    const msg = (data as { error?: unknown }).error;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  }
  return undefined;
}

/**
 * Speech-to-text HTTP client (DESIGN §10). Backend-agnostic: any sidecar that
 * implements the contract works — sherpa/Moonshine (edge), stt-whisper
 * (faster-whisper tiny…large-v3 on x86), or stt-mock. See docs/voice-backends.md.
 *
 * Batch: POST /asr — whole utterance (smoke tests, synthetic admin turns).
 * Stream: POST /asr/stream — partial/final + optional KWS fields.
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
        responseType: "json",
        maxBodyLength: Infinity,
      });
      const text = typeof data?.text === "string" ? data.text.trim() : "";
      this.logger?.debug({ chars: text.length }, "STT transcribed utterance");
      return text;
    } catch (err: unknown) {
      this.logger?.warn({ err: errorMessage(err), url: this.url }, "STT request failed");
      return "";
    }
  }

  /** Feed a PCM chunk; returns partial/final transcripts from the streaming sidecar. */
  async feedStream(
    clientId: number,
    pcm: Buffer,
    sampleRate: number,
    channels: number,
  ): Promise<StreamSttResult> {
    try {
      const { data } = await axios.post(`${this.url}/asr/stream`, pcm, {
        timeout: this.timeoutMs,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Client-Id": String(clientId),
          "X-Sample-Rate": String(sampleRate),
          "X-Channels": String(channels),
        },
        responseType: "json",
        maxBodyLength: Infinity,
      });
      const partial = typeof data?.partial === "string" ? data.partial.trim() : "";
      const finalRaw = data?.final;
      const final = typeof finalRaw === "string" && finalRaw.trim() ? finalRaw.trim() : null;
      const speaking = !!data?.speaking || !!partial || !!final;
      const keywordRaw = data?.keyword;
      const keyword =
        typeof keywordRaw === "string" && keywordRaw.trim() ? keywordRaw.trim() : null;
      const listeningRaw = data?.listening;
      const listening =
        listeningRaw === "passive" || listeningRaw === "command" ? listeningRaw : undefined;
      const commandSourceRaw = data?.commandSource;
      const commandSource =
        commandSourceRaw === "kws" || commandSourceRaw === "asr" ? commandSourceRaw : undefined;
      return {
        partial,
        final,
        speaking,
        keyword,
        listening,
        commandFinal: !!data?.commandFinal,
        commandSource,
      };
    } catch (err: unknown) {
      const detail = streamErrorDetail(err);
      this.logger?.warn(
        { err: errorMessage(err), detail, url: this.url, clientId },
        "STT stream chunk failed",
      );
      return { partial: "", final: null, speaking: false, error: detail ?? errorMessage(err) };
    }
  }

  async resetStream(clientId: number): Promise<void> {
    try {
      await axios.delete(`${this.url}/asr/stream`, {
        timeout: this.timeoutMs,
        headers: { "X-Client-Id": String(clientId) },
      });
    } catch (err: unknown) {
      this.logger?.debug({ err: errorMessage(err), clientId }, "STT stream reset failed");
    }
  }

  /** Keep sherpa in command mode without clearing the decode buffer. */
  async extendCommandMode(clientId: number): Promise<void> {
    try {
      await axios.post(`${this.url}/asr/stream`, Buffer.alloc(0), {
        timeout: this.timeoutMs,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Client-Id": String(clientId),
          "X-Command-Mode": "extend",
        },
      });
    } catch (err: unknown) {
      this.logger?.debug({ err: errorMessage(err), clientId }, "STT command extend failed");
    }
  }

  /** Drop wake-word tail audio from the command buffer; stays in command mode. */
  async clearCommandBuffer(clientId: number): Promise<void> {
    try {
      await axios.post(`${this.url}/asr/stream`, Buffer.alloc(0), {
        timeout: this.timeoutMs,
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Client-Id": String(clientId),
          "X-Command-Mode": "clear",
        },
      });
    } catch (err: unknown) {
      this.logger?.debug({ err: errorMessage(err), clientId }, "STT command buffer clear failed");
    }
  }
}