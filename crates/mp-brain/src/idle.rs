// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Unload the chat model after the channel stays empty. Port of `llm/idle-unload.ts`.

pub const LLM_IDLE_UNLOAD_SECONDS_DEFAULT: u64 = 900;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleEvent {
    None,
    Armed,
    Unload,
    Warm,
}

#[derive(Debug, Clone)]
pub struct LlmIdleGate {
    seconds: u64,
    armed_at: Option<u64>,
    unloaded: bool,
}

impl LlmIdleGate {
    pub fn new(seconds: u64) -> Self {
        Self {
            seconds,
            armed_at: None,
            unloaded: false,
        }
    }

    pub fn on_human_count(&mut self, humans: u32, now_ms: u64) -> IdleEvent {
        if humans >= 1 {
            self.armed_at = None;
            if self.unloaded {
                self.unloaded = false;
                return IdleEvent::Warm;
            }
            return IdleEvent::None;
        }
        if self.seconds == 0 || self.unloaded {
            return IdleEvent::None;
        }
        if self.armed_at.is_none() {
            self.armed_at = Some(now_ms);
            return IdleEvent::Armed;
        }
        let armed = self.armed_at.unwrap_or(now_ms);
        if now_ms.saturating_sub(armed) >= self.seconds.saturating_mul(1000) {
            self.unloaded = true;
            self.armed_at = None;
            return IdleEvent::Unload;
        }
        IdleEvent::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_channel_unloads_then_join_warms() {
        let mut gate = LlmIdleGate::new(900);
        assert_eq!(gate.on_human_count(0, 0), IdleEvent::Armed);
        assert_eq!(gate.on_human_count(0, 899_000), IdleEvent::None);
        assert_eq!(gate.on_human_count(0, 900_000), IdleEvent::Unload);
        assert_eq!(gate.on_human_count(2, 901_000), IdleEvent::Warm);
        assert_eq!(gate.on_human_count(2, 902_000), IdleEvent::None);
    }

    #[test]
    fn occupied_cancels_the_timer() {
        let mut gate = LlmIdleGate::new(900);
        assert_eq!(gate.on_human_count(0, 0), IdleEvent::Armed);
        assert_eq!(gate.on_human_count(1, 1000), IdleEvent::None);
        assert_eq!(gate.on_human_count(0, 2000), IdleEvent::Armed);
    }
}
