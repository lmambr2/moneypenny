/**
 * Voice pipeline types (DESIGN §10).
 *
 * The pipeline is turn-based: inbound per-speaker audio → VAD end-pointing →
 * STT → the SAME ControlRouter the chat path uses → optional TTS reply. STT/TTS
 * run on the CPU (sherpa-onnx / Kokoro) to keep the NPU free for the LLM.
 */

/** A completed, end-pointed speech segment from one speaker. */
export interface Utterance {
  /** TeamSpeak client id the audio came from. */
  speakerClientId: number;
  /** Resolved unique id, when known (used for rank gating + history). */
  speakerUid?: string;
  /** 16-bit little-endian PCM samples. */
  pcm: Buffer;
  sampleRate: number;
  channels: number;
  durationMs: number;
}

/** Streaming STT chunk result (sherpa-onnx /asr/stream). */
export interface StreamSttResult {
  partial: string;
  final: string | null;
  speaking: boolean;
  /** sherpa-onnx KWS wake-word hit on this chunk (e.g. MONEYPENNY). */
  keyword?: string | null;
  /** Sidecar phase: passive (KWS only) or command (post-wake STT). */
  listening?: "passive" | "command";
  /** Final transcript captured in post-wake command mode — safe to route. */
  commandFinal?: boolean;
  /** How the command final was produced — closed-vocab KWS vs Moonshine ASR. */
  commandSource?: "kws" | "asr";
  /** Set when the streaming sidecar returned an HTTP or transport error. */
  error?: string;
}

/** Speech-to-text (sherpa-onnx). Returns the transcript ("" if nothing heard). */
export interface SttProvider {
  transcribe(utterance: Utterance): Promise<string>;
  feedStream?(
    clientId: number,
    pcm: Buffer,
    sampleRate: number,
    channels: number,
  ): Promise<StreamSttResult>;
  resetStream?(clientId: number): Promise<void>;
}

/** Text-to-speech (Kokoro / Piper). Returns encoded audio bytes + container. */
export interface TtsProvider {
  synthesize(text: string): Promise<{ audio: Buffer; format: string }>;
}

/** Sink for synthesized speech — plays it back into the channel. */
export interface VoiceOutput {
  speak(audio: Buffer, format: string): Promise<void>;
}

export interface VoiceConfig {
  /** Master switch for the inbound voice loop. */
  enabled: boolean;
  /** Speak replies back via TTS (vs. text-only responses in chat). */
  respondWithVoice: boolean;
  /** STT sidecar base URL (HTTP). Empty → STT disabled. Any engine: sherpa / stt-whisper / mock. */
  sttUrl: string;
  /** TTS base URL (OpenAI `/v1/audio/speech`). Empty → TTS disabled. Kokoro or piper-tts. */
  ttsUrl: string;
  /** TTS voice name (Kokoro id or Piper voice label). */
  ttsVoice: string;
  /** RMS threshold for energy VAD (0..32768). Lower = more sensitive. */
  energyThreshold?: number;
  /** Spoken wake phrase required before a voice command is routed (default: Moneypenny). */
  watchword: string;
  /** When true, ignore utterances that do not contain the watchword. */
  requireWatchword: boolean;
  /** Duck bot playback volume while STT runs so channel music does not bleed into the mic. */
  duckMusicOnSpeech: boolean;
  /** Target player volume (0–100) while ducked for voice capture. */
  duckMusicVolume?: number;
  /** After watchword-only, accept a follow-up command without repeating the watchword (ms). */
  listenWindowMs: number;
  /** Max simultaneous passive KWS streams (sherpa CPU scales with open mics). */
  passiveKwsMaxSpeakers?: number;
  /** Prefix text wake matching for stt-mock / smoke tests. Off in production (KWS only). */
  textWakeFallback?: boolean;
}

export function defaultVoiceConfig(): VoiceConfig {
  return {
    enabled: false,
    respondWithVoice: true,
    sttUrl: "",
    ttsUrl: "",
    // Piper default: British female medium (samples: https://rhasspy.github.io/piper-samples/).
    ttsVoice: "en_GB-cori-medium",
    energyThreshold: 200,
    watchword: "moneypenny",
    requireWatchword: true,
    duckMusicOnSpeech: true,
    // Soft duck: music stays audible; ~25% is enough for STT without a hard drop.
    duckMusicVolume: 25,
    listenWindowMs: 15000,
    passiveKwsMaxSpeakers: 2,
    // Whisper sidecars have no KWS — text wake matching is required for "Moneypenny …".
    textWakeFallback: true,
  };
}
