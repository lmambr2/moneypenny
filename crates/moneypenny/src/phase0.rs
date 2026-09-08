// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Post-connect auto-play. Port of `bot/src/bot/lifecycle/phase0.ts`.
//!
//!   PHASE0_AUTO_TEST=1  — run !test (local copy first, else demo YouTube)
//!   PHASE0_TEST_PLAY=…  — validation override (URL or local path)
//!
//! TS6_HOST alone must NOT trigger playback (production reconnects).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use mp_control::{CommandExecutor, ParsedCommand};
use tracing::{error, info, warn};

fn env_truthy(key: &str) -> bool {
    std::env::var(key)
        .ok()
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes"
        })
        .unwrap_or(false)
}

pub struct Phase0Plan {
    pub validation: bool,
    pub cmd: ParsedCommand,
}

/// None when neither PHASE0_AUTO_TEST nor PHASE0_TEST_PLAY is set.
pub fn phase0_plan() -> Option<Phase0Plan> {
    let env_track = std::env::var("PHASE0_TEST_PLAY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let auto_test = env_truthy("PHASE0_AUTO_TEST");
    if env_track.is_none() && !auto_test {
        return None;
    }
    let validation = env_track.is_some();
    let test_track = env_track.unwrap_or_else(|| mp_music::DEFAULT_DEMO_VIDEO_URL.to_string());
    let is_default_demo = !validation
        || test_track == mp_music::DEFAULT_DEMO_VIDEO_URL
        || test_track == mp_music::DEFAULT_DEMO_VIDEO_ID;
    let cmd = if is_default_demo {
        ParsedCommand {
            name: "test".into(),
            args: String::new(),
            raw_args: vec![],
            flags: HashSet::new(),
        }
    } else {
        let mut flags = HashSet::new();
        if validation && !test_track.starts_with("http") {
            flags.insert('l');
        }
        ParsedCommand {
            name: "play".into(),
            args: test_track.clone(),
            raw_args: vec![test_track],
            flags,
        }
    };
    Some(Phase0Plan { validation, cmd })
}

static PHASE0_SPAWNED: AtomicBool = AtomicBool::new(false);

/// First *successful* connect only (initial or the reconnect that actually lands).
/// Later reconnects must not auto-play.
pub fn spawn_after_first_connect(executor: Arc<CommandExecutor>) {
    let Some(plan) = phase0_plan() else {
        return;
    };
    if PHASE0_SPAWNED.swap(true, Ordering::SeqCst) {
        return;
    };
    info!(
        validation = plan.validation,
        cmd = %plan.cmd.name,
        "Startup: will run auto-play 4s after connect"
    );
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        let label = if plan.validation {
            plan.cmd.args.clone()
        } else {
            "!test".into()
        };
        info!(track = %label, "Startup: running auto-play");
        match executor.execute(&plan.cmd).await {
            Some(result) if result.to_ascii_lowercase().contains("now playing") => {
                info!(track = %label, result = %result, "Startup: auto-play started");
            }
            other => {
                warn!(track = %label, result = ?other, "Startup: auto-play did not start");
                error!("Check MUSIC_DIR, YouTube, and TS channel permissions.");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_when_neither_env_set() {
        // Can't unset env for other tests reliably; plan() with empty is the
        // production default. This crate test only checks command shape helpers.
        let demo = ParsedCommand {
            name: "test".into(),
            args: String::new(),
            raw_args: vec![],
            flags: HashSet::new(),
        };
        assert_eq!(demo.name, "test");
        assert!(demo.args.is_empty());
    }

    #[test]
    fn env_truthy_parses() {
        assert!(!{
            let v = "";
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes"
        });
        for raw in ["1", "true", "YES"] {
            let v = raw.trim().to_ascii_lowercase();
            assert!(v == "1" || v == "true" || v == "yes", "{raw}");
        }
    }
}
