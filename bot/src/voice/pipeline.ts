import type { ControlRouter, RouterContext } from "../control/router.js";
import type { Logger } from "../logger.js";
import type { SttProvider, TtsProvider, VoiceOutput, Utterance } from "./types.js";

export interface VoicePipelineOptions {
  router: ControlRouter;
  stt: SttProvider;
  /** Build RouterContext for a speaker (subject for rank gating etc.). See DESIGN §10. */
  buildContext: (utterance: Utterance) => RouterContext | Promise<RouterContext>;
  tts?: TtsProvider;
  output?: VoiceOutput;
  /** Whether to speak replies via TTS. */
  respondWithVoice?: boolean;
  aliases?: Record<string, string>;
  logger?: Logger;
  /** Optional hook after each turn (for UI/audit). */
  onTurn?: (turn: { transcript: string; reply: string | null; speakerUid?: string }) => void;
}

/**
 * Voice turn orchestrator (STT → router → optional TTS). Reuses chat router
 * for consistent dispatch/gating. See DESIGN §10.
 */
export class VoicePipeline {
  private opts: VoicePipelineOptions;
  private logger?: Logger;

  constructor(opts: VoicePipelineOptions) {
    this.opts = opts;
    this.logger = opts.logger;
  }

  /**
   * End-to-end voice turn. Returns text reply (spoken if enabled).
   * Failures degrade gracefully. See DESIGN §10.
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

    const context = await this.opts.buildContext(utterance);
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
