/**
 * Voice pipeline types (DESIGN §10).
 * Turn-based: per-speaker audio → VAD → STT → shared router (same dispatch/gating as chat) → optional TTS.
 * CPU for STT/TTS (NPU for LLM).
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

/** Speech-to-text (sherpa-onnx). Returns the transcript ("" if nothing heard). */
export interface SttProvider {
  transcribe(utterance: Utterance): Promise<string>;
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
  /** sherpa-onnx STT endpoint (HTTP). Empty → STT disabled. */
  sttUrl: string;
  /** Kokoro-FastAPI TTS base URL (OpenAI-compatible). Empty → TTS disabled. */
  ttsUrl: string;
  /** TTS voice name. */
  ttsVoice: string;
}

export function defaultVoiceConfig(): VoiceConfig {
  return {
    enabled: false,
    respondWithVoice: true,
    sttUrl: "",
    ttsUrl: "",
    ttsVoice: "af_sky",
  };
}
