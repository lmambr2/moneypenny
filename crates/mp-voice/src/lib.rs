// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! VAD → STT HTTP → same control path as chat → TTS HTTP (rewrite Phase 6).
//! Whisper stays out of process.

mod pipeline;
mod probe;
mod runtime;
mod speak;
mod stt;
mod tts;
mod under_music;
mod vad;
mod watchword;

pub use mp_config::{
    effective_duck_volume, normalize_duck_music_volume, VoiceConfig, DEFAULT_DUCK_MUSIC_VOLUME,
    KARAOKE_DUCK_VOLUME, MIN_LISTEN_WINDOW_MS,
};
pub use pipeline::{TranscriptOpts, VoiceGate, VoicePipeline, VoiceTurnResult};
pub use probe::{probe_http_health, probe_http_stt, probe_http_tts};
pub use runtime::{IngestResult, VoiceRuntime};
pub use speak::{split_spoken_sentences, text_to_spoken, tts_timeout_for_text};
pub use stt::HttpSttClient;
pub use tts::HttpTtsClient;
pub use under_music::{
    plan_under_music, run_under_music_smoke, simulate_under_music_turn, UnderMusicConfig, WakePath,
};
pub use vad::{to_mono_16k, SegmenterOptions, SilenceSegmenter};
pub use watchword::{
    extract_command_segment, extract_watchword_command, is_actionable_voice_command,
    is_music_search_route_text, is_partial_safe_voice_command, is_playback_control_reply,
    is_playback_start_reply, normalize_voice_command, partial_mentions_command,
    should_speak_voice_reply, voice_reply_clears_saved_music, voice_spoken_ack, watchword_aliases,
    WatchwordMatch, WatchwordOptions,
};

#[derive(Debug, Clone)]
pub struct Utterance {
    pub speaker_client_id: i32,
    pub speaker_uid: Option<String>,
    pub pcm: Vec<u8>,
    pub sample_rate: u32,
    pub channels: u32,
    pub duration_ms: f64,
}

#[derive(Debug, Clone, Default)]
pub struct StreamSttResult {
    pub partial: String,
    pub final_text: Option<String>,
    pub speaking: bool,
    pub keyword: Option<String>,
    pub listening: Option<String>,
    pub command_final: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    pub enabled: bool,
    pub active: bool,
    pub stt_url: String,
    pub tts_url: String,
    pub tts_voice: String,
    pub respond_with_voice: bool,
    pub stt_available: bool,
    pub tts_available: bool,
    pub energy_threshold: f64,
    pub watchword: String,
    pub require_watchword: bool,
    pub inbound_packets: u64,
    pub duck_music_on_speech: bool,
    pub text_wake_fallback: bool,
}

#[cfg(test)]
mod tests {
    #[test]
    fn crate_compiles() {
        assert_eq!(env!("CARGO_PKG_NAME"), "mp-voice");
    }
}
