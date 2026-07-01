/**
 * SpeechSink — "text → audio in the channel" for radio (docs/radio.md §4/§5.4).
 * Renders a line through the existing TTS provider and caches the result
 * (§6.5) so repeated station IDs/liners are free. `render()` returns a playable
 * file path (the RadioDirector owns the actual `player.play`); `playSpeech()` is
 * the render-and-play convenience for the future forced-bumper / `!radio say`
 * path (§6.4).
 *
 * This is a standalone unit built on the same primitives as
 * `VoiceSession.createOutput().speak()`; it deliberately does NOT reach into the
 * voice session's captureDuck/savedMusic state. Voice can adopt this later.
 */
import { createHash } from "node:crypto";
import type { AudioPlayer } from "../audio/player.js";
import type { Logger } from "../logger.js";
import type { TtsProvider } from "../voice/types.js";
import type { BumperCache } from "./bumper-cache.js";

export interface SpeechSinkDeps {
  tts: TtsProvider;
  cache: BumperCache;
  logger: Logger;
  /** Voice id, folded into the cache key so a voice change re-renders. */
  voice?: string;
  /** Only needed for playSpeech(); render() is playback-agnostic. */
  player?: Pick<AudioPlayer, "play" | "resetFailures">;
}

export class SpeechSink {
  constructor(private deps: SpeechSinkDeps) {}

  /** Render a line to a cached audio file and return its path, or null on TTS
   *  failure (caller falls back — never blocks music). `source` is recorded for
   *  the cache audit trail. */
  async render(text: string, source = "speech"): Promise<string | null> {
    const clean = text.trim();
    if (!clean) return null;
    const hash = createHash("sha1").update(`${this.deps.voice ?? ""}:${clean}`).digest("hex");
    const cached = this.deps.cache.get(hash);
    if (cached) return cached.path;
    try {
      const { audio, format } = await this.deps.tts.synthesize(clean);
      const path = this.deps.cache.put(hash, audio, format, {
        text: clean,
        source,
        voice: this.deps.voice,
      });
      // put() returns null only for a non-cacheable floor; still play the render
      // by writing an ephemeral copy is out of scope here — radio bumpers are
      // unclassified, so a null return is not expected on this path.
      return path;
    } catch (err) {
      this.deps.logger.warn({ err }, "radio speech: TTS synthesis failed");
      return null;
    }
  }

  /** Render and play immediately (forced bumper / `!radio say`). Returns whether
   *  playback started. */
  async playSpeech(text: string, source = "speech"): Promise<boolean> {
    const path = await this.render(text, source);
    if (!path || !this.deps.player) return false;
    this.deps.player.resetFailures();
    this.deps.player.play(path);
    return true;
  }
}
