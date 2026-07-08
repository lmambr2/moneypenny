import type { ControlRouter, RouterContext } from "../control/router.js";
import type { Logger } from "../logger.js";
import type { SttProvider, TtsProvider, VoiceOutput, Utterance } from "./types.js";
import { isMusicSearchRouteText, voiceRouteNeedsPendingAck } from "./music-command.js";
import {
  isPlaybackControlReply,
  isPlaybackStartReply,
  shouldSpeakVoiceReply,
  voicePlayPendingAck,
  voiceSpokenAck,
} from "./playback-reply.js";
import {
  extractWatchwordCommand,
  isActionableVoiceCommand,
  normalizeVoiceCommand,
} from "./watchword.js";

export interface VoiceTurnResult {
  reply: string | null;
  /** Watchword heard with no command — caller should hold duck until command window ends. */
  watchwordOnly: boolean;
}

export interface VoicePipelineOptions {
  router: ControlRouter;
  stt: SttProvider;
  /** Build the routing context (subject for rank gating, conversationId) for a
   * speaker. May be async so the subject can be resolved live (rank decisions
   * must not trust a cached, reusable client-id binding — audit F-5). */
  buildContext: (utterance: Utterance) => RouterContext | Promise<RouterContext>;
  tts?: TtsProvider;
  output?: VoiceOutput;
  /** Speak replies back via TTS when both tts and output are present. */
  respondWithVoice?: boolean;
  aliases?: Record<string, string>;
  logger?: Logger;
  /** Observability hook — fired after each routed turn (e.g. for the UI / audit). */
  onTurn?: (turn: { transcript: string; reply: string | null; speakerUid?: string }) => void;
  /** Wake phrase (default moneypenny). Ignored when requireWatchword is false. */
  watchword?: string;
  requireWatchword?: boolean;
  /** Prefix text wake for stt-mock / smoke tests. Production uses KWS only. */
  textWakeFallback?: boolean;
  /** Ms to accept a command without the watchword after a watchword-only utterance. */
  listenWindowMs?: number;
  isArmed?: (speakerClientId: number) => boolean;
  arm?: (speakerClientId: number) => void;
  disarm?: (speakerClientId: number) => void;
  /** Blocks duplicate play/search while a prior resolve is in-flight or cooling down. */
  isPlayInFlight?: (speakerClientId: number) => boolean;
  markPlayInFlight?: (speakerClientId: number, query: string) => void;
  clearPlayInFlight?: (speakerClientId: number) => void;
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
  async handleUtterance(utterance: Utterance): Promise<VoiceTurnResult> {
    let transcript = "";
    try {
      transcript = (await this.opts.stt.transcribe(utterance)).trim();
    } catch (err) {
      this.logger?.warn({ err }, "Voice: STT failed");
      return { reply: null, watchwordOnly: false };
    }
    if (!transcript) {
      this.logger?.info(
        { speakerClientId: utterance.speakerClientId, durationMs: Math.round(utterance.durationMs) },
        "Voice: STT returned empty transcript",
      );
      return { reply: null, watchwordOnly: false };
    }
    const out = await this.handleTranscript(transcript, utterance, {
      textWakeFallback: this.opts.textWakeFallback,
    });
    return { reply: out.reply, watchwordOnly: out.watchwordOnly };
  }

  /**
   * Run routing + optional TTS for a known transcript (admin smoke tests — skips STT).
   * When `opts.speak` is false, TTS is synthesized but not played into the channel.
   */
  async handleTranscript(
    transcript: string,
    utterance: Utterance,
    opts: {
      speak?: boolean;
      kwsDetected?: boolean;
      textWakeFallback?: boolean;
    } = {},
  ): Promise<{ reply: string | null; ttsBytes: number; watchwordOnly: boolean }> {
    const trimmed = transcript.trim();
    if (!trimmed) return { reply: null, ttsBytes: 0, watchwordOnly: false };

    let routeText = trimmed;
    let watchwordOnly = false;
    const watchword = this.opts.watchword ?? "moneypenny";
    const armed = this.opts.isArmed?.(utterance.speakerClientId) ?? false;
    const textWakeFallback = opts.textWakeFallback ?? this.opts.textWakeFallback ?? false;
    const postWake = opts.kwsDetected || armed;
    const aliases = this.opts.aliases ?? {};
    const clientId = utterance.speakerClientId;

    if (this.opts.requireWatchword !== false) {
      const ww = extractWatchwordCommand(trimmed, watchword, {
        kwsDetected: opts.kwsDetected,
        armed,
        textWakeFallback,
      });
      if (ww.matched && ww.command) {
        if (postWake && !isActionableVoiceCommand(ww.command, aliases)) {
          this.opts.arm?.(clientId);
          this.logger?.info(
            { transcript: trimmed, command: ww.command },
            "Voice: post-wake noise — holding for command",
          );
          return { reply: null, ttsBytes: 0, watchwordOnly: true };
        }
        routeText = ww.command;
        this.logger?.info({ transcript: trimmed, command: routeText }, "Voice: watchword matched");
      } else if (ww.matched) {
        this.opts.arm?.(clientId);
        this.logger?.info(
          { transcript: trimmed, windowMs: this.opts.listenWindowMs ?? 12000 },
          "Voice: watchword only — armed for follow-up command",
        );
        return { reply: null, ttsBytes: 0, watchwordOnly: true };
      } else if (armed) {
        routeText = normalizeVoiceCommand(trimmed);
        if (!isActionableVoiceCommand(routeText, aliases)) {
          this.opts.arm?.(clientId);
          this.logger?.info({ transcript: trimmed }, "Voice: armed — waiting for command");
          return { reply: null, ttsBytes: 0, watchwordOnly: true };
        }
        this.logger?.info({ transcript: trimmed, command: routeText }, "Voice: armed follow-up command");
      } else {
        this.logger?.info({ transcript: trimmed }, "Voice: ignored — not in command window");
        return { reply: null, ttsBytes: 0, watchwordOnly: false };
      }
    }

    if (!routeText) {
      return { reply: null, ttsBytes: 0, watchwordOnly: false };
    }

    if (isMusicSearchRouteText(routeText, aliases) && this.opts.isPlayInFlight?.(clientId)) {
      this.logger?.info({ clientId, command: routeText }, "Voice: play resolve in-flight — ignoring duplicate");
      const ttsBytes = await this.speakInstantPhrase("Still working on that.", opts.speak);
      return { reply: null, ttsBytes, watchwordOnly: false };
    }

    const context = await this.opts.buildContext(utterance);
    let reply: string | null = null;
    let markedInFlight = false;
    let pendingAckBytes = 0;

    try {
      const decision = await this.opts.router.routeVoice(routeText, context, aliases);

      if (voiceRouteNeedsPendingAck(decision, routeText, aliases)) {
        this.opts.markPlayInFlight?.(clientId, routeText);
        markedInFlight = true;
        pendingAckBytes = await this.speakInstantPhrase(voicePlayPendingAck(), opts.speak);
      }

      reply = await this.opts.router.execute(decision, context);

      if (isPlaybackStartReply(reply) || isPlaybackControlReply(reply)) {
        this.opts.disarm?.(clientId);
      } else if (reply) {
        this.opts.arm?.(clientId);
      }
    } catch (err) {
      this.logger?.warn({ err, transcript: trimmed, command: routeText }, "Voice: routing/execution failed");
    } finally {
      if (markedInFlight && !isPlaybackStartReply(reply)) {
        this.opts.clearPlayInFlight?.(clientId);
      }
    }

    this.opts.onTurn?.({ transcript: trimmed, reply, speakerUid: utterance.speakerUid });

    let ttsBytes = pendingAckBytes;
    const shouldSpeak = opts.speak !== false;
    const speakReply =
      reply &&
      this.opts.respondWithVoice &&
      this.opts.tts &&
      shouldSpeakVoiceReply(reply) &&
      (shouldSpeak ? this.opts.output : true);

    if (speakReply && reply && this.opts.tts) {
      const ttsText = voiceSpokenAck(reply) ?? reply;
      try {
        const { audio, format } = await this.opts.tts.synthesize(ttsText);
        ttsBytes += audio.length;
        if (shouldSpeak && this.opts.output) {
          await this.opts.output.speak(audio, format);
        }
      } catch (err) {
        this.logger?.warn({ err }, "Voice: TTS/playback failed");
      }
    } else if (reply && this.opts.respondWithVoice && !shouldSpeakVoiceReply(reply)) {
      this.logger?.info(
        { chars: reply.length, playback: reply.length <= 40 },
        "Voice: skipping TTS for this reply",
      );
    }

    return { reply, ttsBytes, watchwordOnly };
  }

  private async speakInstantPhrase(text: string, speak?: boolean): Promise<number> {
    if (!this.opts.respondWithVoice || !this.opts.tts || !this.opts.output || speak === false) {
      return 0;
    }
    try {
      const { audio, format } = await this.opts.tts.synthesize(text);
      await this.opts.output.speak(audio, format);
      return audio.length;
    } catch (err) {
      this.logger?.warn({ err, text }, "Voice: instant ack TTS failed");
      return 0;
    }
  }
}