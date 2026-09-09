// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Settings-backed auto-follow flags. The actual move lives in the bot loop.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

pub struct FollowRuntime {
    enabled: AtomicBool,
    cooldown_sec: AtomicU64,
    afk: Mutex<Vec<String>>,
}

impl FollowRuntime {
    pub fn from_config(enabled: bool, cooldown_sec: u64, afk: Vec<String>) -> Self {
        Self {
            enabled: AtomicBool::new(enabled),
            cooldown_sec: AtomicU64::new(cooldown_sec),
            afk: Mutex::new(if afk.is_empty() {
                default_afk_channels()
            } else {
                afk
            }),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::SeqCst);
    }

    pub fn cooldown_sec(&self) -> u64 {
        self.cooldown_sec.load(Ordering::SeqCst)
    }

    pub fn set_cooldown_sec(&self, sec: u64) {
        self.cooldown_sec.store(sec, Ordering::SeqCst);
    }

    pub fn afk_channels(&self) -> Vec<String> {
        self.afk.lock().expect("afk").clone()
    }

    pub fn set_afk_channels(&self, names: Vec<String>) {
        *self.afk.lock().expect("afk") = names;
    }
}

pub fn default_afk_channels() -> Vec<String> {
    ["AFK", "Away", "AFK / Away"]
        .into_iter()
        .map(str::to_string)
        .collect()
}
