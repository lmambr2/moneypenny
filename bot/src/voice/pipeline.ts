import type { ControlRouter, RouterContext } from "../control/router.js";
import type { Logger } from "../logger.js";
import type { SttProvider, TtsProvider, VoiceOutput, Utterance } from "./types.js";

export interface VoicePipelineOptions {
  router: ControlRouter;
  stt: SttProvider;
  /** Build the routing context (subject for rank gating, conversationId) for a speaker. */
  buildContext: (utterance: Utterance) => RouterContext;
  tts?: TtsProvider;
  output?: VoiceOutput;
  /** Speak replies back via TTS when both tts and output are present. */
  respondWithVoice?: boolean;
  aliases?: Record<string, string>;
  logger?: Logger;
  /** Observability hook — fired after each turn (e.g. for the UI / audit). */
  onTurn?: (turn: { transcript: string; reply: string | null; speakerUid?: string }) => void;
}

/**
 * Orchestrates one voice turn (DESIGN §10): STT → ControlRouter.routeVoice →
 * execute → optional spoken reply. Deliberately reuses the chat router so voice
 * inherits deterministic-first dispatch, LLM fuzzy intent, AND rank gating —
 * there is no separate command path for voice.
 */
export class VoicePipeline {
  private opts: VoicePipelineOptions;
  private logger?: Logger;

  constructor(opts: VoicePipelineOptions) {
    this.opts = opts;
    this.logger = opts.logger;
  }

  /**
   * Process a completed utterance end-to-end. Returns the textual reply (also
   * spoken aloud when voice replies are enabled), or null if nothing actionable
   * was heard. Never throws — STT/router/TTS failures degrade gracefully.
   */
  async handleUtterance(utterance: Utterance): Promise<string | null> {
    let transcript = "";
    try {
      transcript = (await this.opts.stt.transcribe(utterance)).trim();
    } catch (err) {
      this.logger?.warn({ err }, "Voice: STT failed");
      return null;
    }
    if (!transcript) return null;

    const context = this.opts.buildContext(utterance);
    let reply: string | null = null;
    try {
      const decision = await this.opts.router.routeVoice(transcript, context, this.opts.aliases ?? {});
      reply = await this.opts.router.execute(decision, context);
    } catch (err) {
      this.logger?.warn({ err, transcript }, "Voice: routing/execution failed");
    }

    this.opts.onTurn?.({ transcript, reply, speakerUid: utterance.speakerUid });

    if (reply && this.opts.respondWithVoice && this.opts.tts && this.opts.output) {
      try {
        const { audio, format } = await this.opts.tts.synthesize(reply);
        await this.opts.output.speak(audio, format);
      } catch (err) {
        this.logger?.warn({ err }, "Voice: TTS/playback failed");
      }
    }

    return reply;
  }
}
