// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Duplex Talker watch-state. Pure reducer — no socket.
//! Crash (`ok=false`) falls back and returns to idle when the adapter is back.
//! RTF hold stays until the operator sets `voice.mode=duplex` again.
//! Empty-channel unload stays idle.

use serde_json::Value;

pub const RTF_REALTIME: f64 = 1.15;
pub const FALLBACK_HOLD_MS: u64 = 8_000;
pub const TALKER_VRAM_IDLE_MB: f64 = 256.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchState {
    Idle,
    ArmedDuplex,
    FallbackCascaded,
    FallbackRtf,
}

impl WatchState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::ArmedDuplex => "armed-duplex",
            Self::FallbackCascaded => "fallback-cascaded",
            Self::FallbackRtf => "fallback-rtf",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchAction {
    Warm,
    Unload,
    MuteOut,
}

#[derive(Debug, Clone)]
pub struct DuplexHealth {
    pub ok: bool,
    pub loaded: Option<bool>,
    pub engine: Option<String>,
    pub realtime: Option<bool>,
    pub rtf: Option<f64>,
    pub vram_mb: Option<f64>,
}

impl DuplexHealth {
    pub fn unreachable() -> Self {
        Self {
            ok: false,
            loaded: None,
            engine: None,
            realtime: None,
            rtf: None,
            vram_mb: None,
        }
    }
}

pub fn parse_health(raw: &Value) -> DuplexHealth {
    let Some(o) = raw.as_object() else {
        return DuplexHealth::unreachable();
    };
    DuplexHealth {
        ok: o.get("ok").and_then(|v| v.as_bool()) == Some(true),
        loaded: o.get("loaded").and_then(|v| v.as_bool()),
        engine: o.get("engine").and_then(|v| v.as_str()).map(str::to_string),
        realtime: o.get("realtime").and_then(|v| v.as_bool()),
        rtf: o.get("rtf").and_then(|v| v.as_f64()),
        vram_mb: o.get("vram_mb").and_then(|v| v.as_f64()),
    }
}

#[derive(Debug)]
pub struct DuplexWatch {
    pub state: WatchState,
    rtf_bad_since_ms: Option<u64>,
}

impl Default for DuplexWatch {
    fn default() -> Self {
        Self {
            state: WatchState::Idle,
            rtf_bad_since_ms: None,
        }
    }
}

impl DuplexWatch {
    pub fn apply_health(&mut self, health: &DuplexHealth, now_ms: u64) -> Vec<WatchAction> {
        let mut actions = Vec::new();
        if !health.ok {
            self.rtf_bad_since_ms = None;
            if self.state != WatchState::FallbackCascaded {
                if health.loaded == Some(true) {
                    actions.push(WatchAction::MuteOut);
                    actions.push(WatchAction::Unload);
                }
                self.state = WatchState::FallbackCascaded;
            }
            return actions;
        }
        if self.state == WatchState::FallbackCascaded {
            self.rtf_bad_since_ms = None;
            self.state = WatchState::Idle;
            return actions;
        }
        if self.state == WatchState::FallbackRtf {
            self.rtf_bad_since_ms = None;
            return actions;
        }
        let loaded = health.loaded == Some(true);
        let realtime = health.realtime == Some(true);
        if loaded && !realtime {
            if self.rtf_bad_since_ms.is_none() {
                self.rtf_bad_since_ms = Some(now_ms);
            }
            if now_ms.saturating_sub(self.rtf_bad_since_ms.unwrap_or(now_ms)) >= FALLBACK_HOLD_MS {
                self.state = WatchState::FallbackRtf;
                self.rtf_bad_since_ms = None;
                actions.push(WatchAction::MuteOut);
                actions.push(WatchAction::Unload);
            }
        } else {
            self.rtf_bad_since_ms = None;
        }
        actions
    }

    pub fn on_watchword(&mut self, loaded: bool) -> Vec<WatchAction> {
        if self.state == WatchState::FallbackRtf || self.state == WatchState::FallbackCascaded {
            return Vec::new();
        }
        let mut actions = Vec::new();
        if !loaded {
            actions.push(WatchAction::Warm);
        }
        self.state = WatchState::ArmedDuplex;
        actions
    }

    pub fn on_listen_expired(&mut self) {
        if self.state == WatchState::ArmedDuplex {
            self.state = WatchState::Idle;
        }
    }

    pub fn on_empty_channel(&mut self, loaded: bool) -> Vec<WatchAction> {
        if self.state == WatchState::FallbackRtf || self.state == WatchState::FallbackCascaded {
            return Vec::new();
        }
        self.state = WatchState::Idle;
        if loaded {
            vec![WatchAction::MuteOut, WatchAction::Unload]
        } else {
            Vec::new()
        }
    }

    /// Operator sets `voice.mode=duplex`. Only exit from sticky RTF fallback.
    pub fn on_operator_set_duplex(&mut self) {
        if self.state == WatchState::FallbackRtf {
            self.state = WatchState::Idle;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn health(ok: bool, loaded: bool, realtime: bool) -> DuplexHealth {
        DuplexHealth {
            ok,
            loaded: Some(loaded),
            engine: Some("moshicpp-vulkan".into()),
            realtime: Some(realtime),
            rtf: Some(if realtime { 1.0 } else { 2.0 }),
            vram_mb: Some(if loaded { 4000.0 } else { 0.0 }),
        }
    }

    #[test]
    fn crash_returns_to_idle_without_warm() {
        let mut w = DuplexWatch::default();
        let actions = w.apply_health(&health(false, true, true), 0);
        assert_eq!(w.state, WatchState::FallbackCascaded);
        assert_eq!(actions, vec![WatchAction::MuteOut, WatchAction::Unload]);
        let actions = w.apply_health(&health(true, false, false), 1);
        assert_eq!(w.state, WatchState::Idle);
        assert!(actions.is_empty());
    }

    #[test]
    fn rtf_hold_is_sticky_until_the_operator() {
        let mut w = DuplexWatch::default();
        assert!(w.apply_health(&health(true, true, false), 0).is_empty());
        let actions = w.apply_health(&health(true, true, false), FALLBACK_HOLD_MS);
        assert_eq!(w.state, WatchState::FallbackRtf);
        assert_eq!(actions, vec![WatchAction::MuteOut, WatchAction::Unload]);
        w.apply_health(&health(true, false, false), FALLBACK_HOLD_MS + 1);
        assert_eq!(w.state, WatchState::FallbackRtf);
        w.on_operator_set_duplex();
        assert_eq!(w.state, WatchState::Idle);
    }
}
