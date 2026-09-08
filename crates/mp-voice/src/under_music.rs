// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Under-music progressive wake (V1/H4). Pure helpers + admin smoke API.

use mp_config::{effective_duck_volume, VoiceConfig, MIN_LISTEN_WINDOW_MS};

use crate::watchword::{extract_watchword_command, WatchwordOptions};

#[derive(Debug, Clone)]
pub struct UnderMusicConfig {
    pub duck_music_on_speech: bool,
    pub duck_music_volume: u32,
    pub karaoke_mode: bool,
    pub listen_window_ms: u64,
    pub text_wake_fallback: bool,
    pub watchword: String,
}

impl UnderMusicConfig {
    pub fn from_voice(cfg: &VoiceConfig) -> Self {
        Self {
            duck_music_on_speech: cfg.duck_music_on_speech,
            karaoke_mode: cfg.karaoke_mode,
            duck_music_volume: effective_duck_volume(cfg.karaoke_mode, cfg.duck_music_volume),
            listen_window_ms: cfg.listen_window_ms.max(MIN_LISTEN_WINDOW_MS),
            text_wake_fallback: cfg.text_wake_fallback,
            watchword: cfg.watchword.to_ascii_lowercase(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WakePath {
    TextWake,
    Kws,
    Armed,
    None,
}

impl WakePath {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::TextWake => "text-wake",
            Self::Kws => "kws",
            Self::Armed => "armed",
            Self::None => "none",
        }
    }
}

pub fn plan_under_music(cfg: &UnderMusicConfig) -> serde_json::Value {
    let mut notes = Vec::new();
    if cfg.duck_music_on_speech {
        notes.push(if cfg.karaoke_mode {
            format!(
                "Karaoke ON — music ducks to volume {} while listening.",
                cfg.duck_music_volume
            )
        } else {
            format!(
                "Music ducks to volume {} while listening.",
                cfg.duck_music_volume
            )
        });
    } else {
        notes.push("Duck is off — STT under DJ load will struggle.".into());
    }
    notes.push(format!(
        "Post-wake listen window {}ms (min 15s).",
        cfg.listen_window_ms
    ));
    if cfg.text_wake_fallback {
        notes.push(
            "Text wake fallback ON — “Moneypenny pause” works without KWS (Whisper path).".into(),
        );
    } else {
        notes.push("Text wake fallback OFF — requires KWS or armed follow-up.".into());
    }
    notes.push("Typed/chat commands always work as text fallback for transport.".into());
    serde_json::json!({
        "duckActive": cfg.duck_music_on_speech,
        "duckLevel": cfg.duck_music_volume,
        "listenWindowMs": cfg.listen_window_ms,
        "progressiveWake": if cfg.text_wake_fallback { "text-fallback" } else { "kws-only" },
        "textFallbackAlwaysWorks": true,
        "notes": notes,
    })
}

pub fn simulate_under_music_turn(
    transcript: &str,
    cfg: &UnderMusicConfig,
    kws_detected: bool,
    armed: bool,
) -> (bool, String, WakePath, bool, Option<String>) {
    let text = transcript.trim();
    let match_ = extract_watchword_command(
        text,
        &cfg.watchword,
        WatchwordOptions {
            text_wake_fallback: cfg.text_wake_fallback,
            kws_detected,
            armed,
        },
    );
    let mut path = WakePath::None;
    if match_.matched {
        if kws_detected {
            path = WakePath::Kws;
        } else if armed && !cfg.text_wake_fallback {
            path = WakePath::Armed;
        } else if armed && !text.to_ascii_lowercase().contains(&cfg.watchword) {
            path = WakePath::Armed;
        } else if cfg.text_wake_fallback {
            path = WakePath::TextWake;
        } else {
            path = WakePath::Armed;
        }
    }
    let command = if match_.matched {
        match_.command.trim().to_string()
    } else {
        String::new()
    };
    let would_duck = cfg.duck_music_on_speech && match_.matched;
    let fallback = if !command.is_empty() {
        Some(command.clone())
    } else if armed {
        Some(text.to_string())
    } else if !match_.matched
        && regex_transport(text)
    {
        Some(text.to_string())
    } else {
        None
    };
    (match_.matched, command, path, would_duck, fallback.filter(|s| !s.trim().is_empty()))
}

fn regex_transport(text: &str) -> bool {
    let t = text.trim().to_ascii_lowercase();
    ["pause", "skip", "stop", "resume", "next", "prev"]
        .iter()
        .any(|v| t == *v || t.starts_with(&format!("{v} ")))
}

pub struct SmokeCase {
    pub id: &'static str,
    pub transcript: &'static str,
    pub kws_detected: bool,
    pub armed: bool,
    pub expect_matched: bool,
    pub expect_command_includes: Option<&'static str>,
    pub expect_path: Option<WakePath>,
}

pub fn default_smoke_cases() -> Vec<SmokeCase> {
    vec![
        SmokeCase {
            id: "text-wake-pause",
            transcript: "Moneypenny pause",
            kws_detected: false,
            armed: false,
            expect_matched: true,
            expect_command_includes: Some("pause"),
            expect_path: Some(WakePath::TextWake),
        },
        SmokeCase {
            id: "text-wake-skip",
            transcript: "Moneypenny skip",
            kws_detected: false,
            armed: false,
            expect_matched: true,
            expect_command_includes: Some("skip"),
            expect_path: Some(WakePath::TextWake),
        },
        SmokeCase {
            id: "armed-followup",
            transcript: "pause",
            kws_detected: false,
            armed: true,
            expect_matched: true,
            expect_command_includes: Some("pause"),
            expect_path: Some(WakePath::Armed),
        },
        SmokeCase {
            id: "banter-no-wake",
            transcript: "I need to pause and think",
            kws_detected: false,
            armed: false,
            expect_matched: false,
            expect_command_includes: None,
            expect_path: Some(WakePath::None),
        },
        SmokeCase {
            id: "kws-path",
            transcript: "skip",
            kws_detected: true,
            armed: false,
            expect_matched: true,
            expect_command_includes: Some("skip"),
            expect_path: Some(WakePath::Kws),
        },
    ]
}

pub fn run_under_music_smoke(cfg: &UnderMusicConfig) -> serde_json::Value {
    let plan = plan_under_music(cfg);
    let mut results = Vec::new();
    let mut ok = true;
    for c in default_smoke_cases() {
        let mut case_cfg = cfg.clone();
        if c.armed && !c.transcript.to_ascii_lowercase().contains(&cfg.watchword) {
            case_cfg.text_wake_fallback = false;
        }
        let (matched, command, path, would_duck, fallback) =
            simulate_under_music_turn(c.transcript, &case_cfg, c.kws_detected, c.armed);
        let mut pass = matched == c.expect_matched;
        let mut reason = None;
        if pass {
            if let Some(inc) = c.expect_command_includes {
                if !command.to_ascii_lowercase().contains(&inc.to_ascii_lowercase()) {
                    pass = false;
                    reason = Some(format!("command \"{command}\" missing \"{inc}\""));
                }
            }
        }
        if pass {
            if let Some(ep) = &c.expect_path {
                if path != *ep {
                    pass = false;
                    reason = Some(format!("path {} !== {}", path.as_str(), ep.as_str()));
                }
            }
        }
        if !pass && reason.is_none() {
            reason = Some(format!("matched={matched} expected={}", c.expect_matched));
        }
        if !pass {
            ok = false;
        }
        results.push(serde_json::json!({
            "id": c.id,
            "transcript": c.transcript,
            "matched": matched,
            "command": command,
            "path": path.as_str(),
            "wouldDuck": would_duck,
            "textFallbackCommand": fallback,
            "pass": pass,
            "reason": reason,
        }));
    }
    serde_json::json!({ "ok": ok, "plan": plan, "results": results })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mp_config::VoiceConfig;

    #[test]
    fn smoke_passes_defaults() {
        let cfg = UnderMusicConfig::from_voice(&VoiceConfig::default());
        let report = run_under_music_smoke(&cfg);
        assert_eq!(report["ok"], true, "{report}");
    }
}
