// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! STT transcript → watchword gate → caller-supplied dispose (same path as chat).

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use mp_config::{VoiceConfig, MIN_LISTEN_WINDOW_MS};

use crate::speak::text_to_spoken;
use crate::tts::HttpTtsClient;
use crate::watchword::{
    extract_watchword_command, is_actionable_voice_command, is_playback_control_reply,
    is_playback_start_reply, normalize_voice_command, should_speak_voice_reply, voice_spoken_ack,
    WatchwordOptions,
};

#[derive(Debug, Clone, Default)]
pub struct TranscriptOpts {
    pub speak: Option<bool>,
    pub kws_detected: bool,
    pub text_wake_fallback: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct VoiceTurnResult {
    pub reply: Option<String>,
    pub watchword_only: bool,
    pub tts_bytes: usize,
    pub tts_audio: Option<Vec<u8>>,
    pub command: Option<String>,
}

#[derive(Debug, Clone)]
pub enum VoiceGate {
    Ignored,
    WatchwordOnly,
    Command(String),
}

pub struct VoicePipeline {
    pub watchword: String,
    pub require_watchword: bool,
    pub text_wake_fallback: bool,
    pub listen_window: Duration,
    pub aliases: HashMap<String, String>,
    pub respond_with_voice: bool,
    armed: Mutex<HashMap<i32, Instant>>,
}

impl VoicePipeline {
    pub fn from_config(cfg: &VoiceConfig, aliases: HashMap<String, String>) -> Self {
        let ms = cfg.listen_window_ms.max(MIN_LISTEN_WINDOW_MS);
        Self {
            watchword: if cfg.watchword.is_empty() {
                "moneypenny".into()
            } else {
                cfg.watchword.clone()
            },
            require_watchword: cfg.require_watchword,
            text_wake_fallback: cfg.text_wake_fallback,
            listen_window: Duration::from_millis(ms),
            aliases,
            respond_with_voice: cfg.respond_with_voice,
            armed: Mutex::new(HashMap::new()),
        }
    }

    pub fn is_armed(&self, client_id: i32) -> bool {
        self.expire_arms();
        self.armed
            .lock()
            .expect("arm")
            .get(&client_id)
            .is_some()
    }

    pub fn any_armed(&self) -> bool {
        self.expire_arms();
        !self.armed.lock().expect("arm").is_empty()
    }

    pub fn arm(&self, client_id: i32) {
        self.armed
            .lock()
            .expect("arm")
            .insert(client_id, Instant::now());
    }

    pub fn disarm(&self, client_id: i32) {
        self.armed.lock().expect("arm").remove(&client_id);
    }

    pub fn clear_arms(&self) {
        self.armed.lock().expect("arm").clear();
    }

    pub fn expire_arms(&self) {
        let mut g = self.armed.lock().expect("arm");
        g.retain(|_, at| at.elapsed() < self.listen_window);
    }

    pub fn gate(&self, transcript: &str, speaker_client_id: i32, opts: &TranscriptOpts) -> VoiceGate {
        let trimmed = transcript.trim();
        if trimmed.is_empty() {
            return VoiceGate::Ignored;
        }
        if !self.require_watchword {
            let cmd = normalize_voice_command(trimmed);
            if cmd.is_empty() {
                return VoiceGate::Ignored;
            }
            return VoiceGate::Command(cmd);
        }

        let armed = self.is_armed(speaker_client_id);
        let text_wake = opts.text_wake_fallback.unwrap_or(self.text_wake_fallback);
        let ww = extract_watchword_command(
            trimmed,
            &self.watchword,
            WatchwordOptions {
                kws_detected: opts.kws_detected,
                armed,
                text_wake_fallback: text_wake,
            },
        );
        let post_wake = opts.kws_detected || armed;

        if ww.matched && !ww.command.is_empty() {
            if post_wake && !is_actionable_voice_command(&ww.command, &self.aliases) {
                self.arm(speaker_client_id);
                tracing::info!(transcript = trimmed, command = %ww.command, "Voice: post-wake noise — holding");
                return VoiceGate::WatchwordOnly;
            }
            tracing::info!(transcript = trimmed, command = %ww.command, "Voice: watchword matched");
            return VoiceGate::Command(ww.command);
        }
        if ww.matched {
            self.arm(speaker_client_id);
            tracing::info!(transcript = trimmed, "Voice: watchword only — armed");
            return VoiceGate::WatchwordOnly;
        }
        if armed {
            let route = normalize_voice_command(trimmed);
            if !is_actionable_voice_command(&route, &self.aliases) {
                self.arm(speaker_client_id);
                tracing::info!(transcript = trimmed, "Voice: armed — waiting for command");
                return VoiceGate::WatchwordOnly;
            }
            tracing::info!(transcript = trimmed, command = %route, "Voice: armed follow-up");
            return VoiceGate::Command(route);
        }
        tracing::info!(transcript = trimmed, "Voice: ignored — not in command window");
        VoiceGate::Ignored
    }

    pub async fn handle_transcript<F, Fut>(
        &self,
        transcript: &str,
        speaker_client_id: i32,
        opts: TranscriptOpts,
        execute: F,
        tts: Option<&HttpTtsClient>,
    ) -> VoiceTurnResult
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = Option<String>>,
    {
        let trimmed = transcript.trim();
        if trimmed.is_empty() {
            return VoiceTurnResult::default();
        }
        match self.gate(trimmed, speaker_client_id, &opts) {
            VoiceGate::Ignored => VoiceTurnResult::default(),
            VoiceGate::WatchwordOnly => VoiceTurnResult {
                watchword_only: true,
                ..Default::default()
            },
            VoiceGate::Command(cmd) => {
                let reply = execute(cmd.clone()).await;
                if is_playback_start_reply(reply.as_deref())
                    || is_playback_control_reply(reply.as_deref())
                {
                    self.disarm(speaker_client_id);
                } else if reply.is_some() {
                    self.arm(speaker_client_id);
                }

                let should_speak = opts.speak.unwrap_or(true);
                let mut tts_bytes = 0;
                let mut tts_audio = None;
                if should_speak && self.respond_with_voice {
                    if let Some(tts) = tts {
                        if let Some(ref r) = reply {
                            let spoken = voice_spoken_ack(Some(r)).map(|s| s.to_string());
                            let tts_text = spoken.unwrap_or_else(|| text_to_spoken(r));
                            if !is_playback_start_reply(Some(r))
                                && should_speak_voice_reply(&tts_text, 900)
                                && !tts_text.is_empty()
                            {
                                match tts.synthesize(&tts_text).await {
                                    Ok((audio, _)) => {
                                        tts_bytes = audio.len();
                                        if !audio.is_empty() {
                                            tts_audio = Some(audio);
                                        }
                                    }
                                    Err(e) => tracing::warn!(error = %e, "Voice: TTS failed"),
                                }
                            }
                        }
                    }
                }
                VoiceTurnResult {
                    reply,
                    watchword_only: false,
                    tts_bytes,
                    tts_audio,
                    command: Some(cmd),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mp_config::VoiceConfig;

    fn pipe() -> VoicePipeline {
        let mut cfg = VoiceConfig::default();
        cfg.require_watchword = true;
        cfg.text_wake_fallback = true;
        VoicePipeline::from_config(&cfg, HashMap::new())
    }

    #[tokio::test]
    async fn dispatches_after_watchword() {
        let p = pipe();
        let mut seen = String::new();
        let turn = p
            .handle_transcript(
                "Moneypenny skip",
                1,
                TranscriptOpts {
                    speak: Some(false),
                    text_wake_fallback: Some(true),
                    ..Default::default()
                },
                |cmd| {
                    seen = cmd.clone();
                    async move { Some("Skipped to next.".into()) }
                },
                None,
            )
            .await;
        assert_eq!(seen, "skip");
        assert_eq!(turn.reply.as_deref(), Some("Skipped to next."));
        assert!(!turn.watchword_only);
    }

    #[tokio::test]
    async fn filler_resume() {
        let p = pipe();
        let mut seen = String::new();
        let turn = p
            .handle_transcript(
                "Money, Penny, a resume.",
                1,
                TranscriptOpts {
                    speak: Some(false),
                    text_wake_fallback: Some(true),
                    ..Default::default()
                },
                |cmd| {
                    seen = cmd.clone();
                    async move { Some("Playback resumed.".into()) }
                },
                None,
            )
            .await;
        assert_eq!(seen, "resume");
        assert_eq!(turn.reply.as_deref(), Some("Playback resumed."));
    }

    #[tokio::test]
    async fn ignores_without_watchword() {
        let p = pipe();
        let mut called = false;
        let turn = p
            .handle_transcript(
                "skip",
                1,
                TranscriptOpts {
                    speak: Some(false),
                    text_wake_fallback: Some(true),
                    ..Default::default()
                },
                |_cmd| {
                    called = true;
                    async move { Some("Skipped".into()) }
                },
                None,
            )
            .await;
        assert!(!called);
        assert!(turn.reply.is_none());
        assert!(!turn.watchword_only);
    }

    #[tokio::test]
    async fn arms_on_watchword_only() {
        let p = pipe();
        let turn = p
            .handle_transcript(
                "Moneypenny",
                1,
                TranscriptOpts {
                    speak: Some(false),
                    text_wake_fallback: Some(true),
                    ..Default::default()
                },
                |_cmd| async move { None },
                None,
            )
            .await;
        assert!(turn.watchword_only);
        assert!(p.is_armed(1));
    }

    #[tokio::test]
    async fn armed_follow_up() {
        let p = pipe();
        p.arm(1);
        let mut seen = String::new();
        let turn = p
            .handle_transcript(
                "pause",
                1,
                TranscriptOpts {
                    speak: Some(false),
                    ..Default::default()
                },
                |cmd| {
                    seen = cmd.clone();
                    async move { Some("Paused".into()) }
                },
                None,
            )
            .await;
        assert_eq!(seen, "pause");
        assert_eq!(turn.reply.as_deref(), Some("Paused"));
        assert!(!p.is_armed(1));
    }
}
