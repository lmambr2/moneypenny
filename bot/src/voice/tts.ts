import axios from "axios";
import type { Logger } from "../logger.js";
import type { TtsProvider } from "./types.js";

/**
 * Text-to-speech client for Kokoro-FastAPI (DESIGN §10) — its OpenAI-compatible
 * `/v1/audio/speech` endpoint. Returns encoded audio bytes; the VoiceOutput
 * decodes/plays them (ffmpeg handles the container, so wav/mp3 both work).
 *
 * The same interface fits an NPU Piper backend later — only this client swaps.
 * NOTE: requires Kokoro-FastAPI running; unvalidated against real hardware.
 */
/** Scale TTS HTTP timeout with reply length (long !ask answers need more than 20s). */
export function ttsTimeoutForText(text: string, baseMs = 20_000, maxMs = 120_000): number {
  return Math.min(maxMs, Math.max(baseMs, text.length * 40));
}

export class KokoroTtsClient implements TtsProvider {
  private url: string;
  private voice: string;
  private model: string;
  private format: string;
  private logger?: Logger;
  private timeoutMs: number;

  constructor(opts: {
    url: string;
    voice?: string;
    model?: string;
    format?: string;
    logger?: Logger;
    timeoutMs?: number;
  }) {
    this.url = opts.url.replace(/\/$/, "");
    this.voice = opts.voice || "bf_emma";
    this.model = opts.model || "kokoro";
    this.format = opts.format || "wav";
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  async synthesize(text: string): Promise<{ audio: Buffer; format: string }> {
    const timeout = ttsTimeoutForText(text, this.timeoutMs);
    const { data } = await axios.post(
      `${this.url}/v1/audio/speech`,
      { model: this.model, input: text, voice: this.voice, response_format: this.format },
      { timeout, responseType: "arraybuffer" },
    );
    const audio = Buffer.from(data);
    this.logger?.debug({ bytes: audio.length, format: this.format }, "TTS synthesized reply");
    return { audio, format: this.format };
  }
}
