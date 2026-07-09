import axios from "axios";
import type { Logger } from "../logger.js";
import type { TtsProvider } from "./types.js";
import { normalizeLoudness } from "./loudness.js";

/**
 * Text-to-speech client for OpenAI-compatible `/v1/audio/speech` (DESIGN §10).
 * Works with Kokoro-FastAPI, piper-tts (services/piper-tts), or any drop-in.
 * Returns encoded audio; VoiceOutput + ffmpeg play it (wav/mp3).
 * See docs/voice-backends.md for edge vs server profiles.
 */
/** Scale TTS HTTP timeout with reply length (long !ask answers need more than 20s). */
export function ttsTimeoutForText(text: string, baseMs = 20_000, maxMs = 120_000): number {
  return Math.min(maxMs, Math.max(baseMs, text.length * 40));
}

/** OpenAI-compatible speech client (Piper product TTS; class name historical). */
export class KokoroTtsClient implements TtsProvider {
  private url: string;
  private voice: string;
  private model: string;
  private format: string;
  private logger?: Logger;
  private timeoutMs: number;

  private normalize: (audio: Buffer, format: string, logger?: Logger) => Promise<Buffer>;

  constructor(opts: {
    url: string;
    voice?: string;
    model?: string;
    format?: string;
    logger?: Logger;
    timeoutMs?: number;
    /** Injectable for tests; defaults to ffmpeg loudnorm (see loudness.ts). */
    normalize?: (audio: Buffer, format: string, logger?: Logger) => Promise<Buffer>;
  }) {
    this.url = opts.url.replace(/\/$/, "");
    this.voice = opts.voice || "en_GB-southern_english_female-low";
    this.model = opts.model || "piper";
    this.format = opts.format || "wav";
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.normalize = opts.normalize ?? normalizeLoudness;
  }

  async synthesize(text: string): Promise<{ audio: Buffer; format: string }> {
    const timeout = ttsTimeoutForText(text, this.timeoutMs);
    const { data } = await axios.post(
      `${this.url}/v1/audio/speech`,
      { model: this.model, input: text, voice: this.voice, response_format: this.format },
      { timeout, responseType: "arraybuffer" },
    );
    let audio = Buffer.from(data);
    // Bring speech up to music loudness (fail-open — raw audio on any error).
    audio = await this.normalize(audio, this.format, this.logger);
    this.logger?.debug({ bytes: audio.length, format: this.format }, "TTS synthesized reply");
    return { audio, format: this.format };
  }
}
