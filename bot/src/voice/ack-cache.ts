import type { Logger } from "../logger.js";
import type { TtsProvider } from "./types.js";

/** Instant barge-in phrases — pre-render so they speak before the LLM returns. */
export const INSTANT_ACK_PHRASES = [
  "On it.",
  "Paused.",
  "Resumed.",
  "Skipped.",
  "Stopped.",
  "Still working on that.",
] as const;

export type InstantAckPhrase = (typeof INSTANT_ACK_PHRASES)[number];

/**
 * In-memory TTS cache for the short transport acks. Misses synthesize through
 * the live provider (fail-open). `warm()` is best-effort at pipeline enable.
 */
export class TtsAckCache {
  private cache = new Map<string, { audio: Buffer; format: string }>();
  private tts: TtsProvider | null = null;
  private logger?: Logger;

  constructor(opts?: { logger?: Logger }) {
    this.logger = opts?.logger;
  }

  attach(tts: TtsProvider | null): void {
    this.tts = tts;
  }

  get(text: string): { audio: Buffer; format: string } | undefined {
    return this.cache.get(normalizeAckKey(text));
  }

  async speakOrSynthesize(text: string): Promise<{ audio: Buffer; format: string } | null> {
    const hit = this.get(text);
    if (hit) return hit;
    if (!this.tts) return null;
    const out = await this.tts.synthesize(text);
    this.cache.set(normalizeAckKey(text), out);
    return out;
  }

  async warm(tts: TtsProvider, phrases: readonly string[] = INSTANT_ACK_PHRASES): Promise<void> {
    this.tts = tts;
    for (const phrase of phrases) {
      const key = normalizeAckKey(phrase);
      if (this.cache.has(key)) continue;
      try {
        const out = await tts.synthesize(phrase);
        this.cache.set(key, out);
      } catch (err) {
        this.logger?.warn({ err, phrase }, "TTS ack pre-render failed");
      }
    }
    this.logger?.info({ cached: this.cache.size }, "TTS instant acks warmed");
  }

  clear(): void {
    this.cache.clear();
  }
}

function normalizeAckKey(text: string): string {
  return text
    .trim()
    .replace(/[.!]+$/u, "")
    .toLowerCase();
}
