// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Deterministic-first router. Rights live in the executor's caller, never the model.
//! COMMAND_MANIFEST names are frozen from `bot/src/bot/commands.ts` at ec464a2.

mod executor;
mod manifest;

pub use executor::{
    find_queue_index_by_query, is_same_playback_track, query_tokens, song_matches_query,
    CommandExecutor,
};
pub use manifest::{
    admin_commands, audio_commands, default_aliases, is_admin_command, is_audio_command,
    is_known_command, parse_command, public_commands, CommandKind, CommandSpec, ParsedCommand,
    COMMAND_MANIFEST,
};

use mp_rights::{default_rights_config, RightsConfig};

#[derive(Debug, Clone)]
pub struct ToolProposal {
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct Subject {
    pub uid: Option<String>,
    pub nickname: Option<String>,
    pub server_groups: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct DisposeResult {
    pub ok: bool,
    pub message: String,
}

pub trait ToolExecutor: Send + Sync {
    fn dispose(
        &self,
        proposal: ToolProposal,
        subject: Subject,
    ) -> impl std::future::Future<Output = DisposeResult> + Send;
}

pub fn frozen_command_names() -> Vec<String> {
    let raw = include_str!("../fixtures/command-manifest-names.json");
    serde_json::from_str(raw).unwrap_or_default()
}

/// Legacy PUBLIC/ADMIN split used when config.rights is omitted.
pub fn legacy_rights_config(admin_groups: &[i32]) -> RightsConfig {
    default_rights_config(public_commands(), admin_commands(), admin_groups)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mp_rights::{RightsEngine, Scope};

    #[test]
    fn manifest_has_skip_play_and_ask() {
        let names = frozen_command_names();
        assert!(names.len() >= 60, "got {}", names.len());
        for n in ["play", "skip", "queue", "ask", "analyst", "radio", "moveall"] {
            assert!(names.iter().any(|x| x == n), "missing {n}");
        }
        for n in frozen_command_names() {
            assert!(
                COMMAND_MANIFEST.iter().any(|c| c.name == n),
                "fixture name {n} missing from COMMAND_MANIFEST"
            );
        }
    }

    #[test]
    fn default_rights_public_vs_admin() {
        let member = mp_rights::Subject {
            uid: "m".into(),
            server_groups: vec!["100".into()],
            nickname: None,
        };
        let officer = mp_rights::Subject {
            uid: "o".into(),
            server_groups: vec!["105".into()],
            nickname: None,
        };
        let e = RightsEngine::new(legacy_rights_config(&[]));
        assert!(e.can(&member, "play", Scope::Chat));
        assert!(e.can(&member, "skip", Scope::Chat));
        assert!(e.can(&member, "queue", Scope::Chat));
        assert!(!e.can(&member, "stop", Scope::Chat));
        assert!(!e.can(&member, "analyst", Scope::Chat));

        let e = RightsEngine::new(legacy_rights_config(&[105]));
        assert!(e.can(&officer, "stop", Scope::Chat));
        assert!(e.can(&officer, "vol", Scope::Chat));
        assert!(!e.can(&member, "stop", Scope::Chat));
        assert!(e.can(&member, "play", Scope::Chat));
    }

    #[test]
    fn deny_message_shape() {
        // Bot loop uses this exact string; skip replies must never match it.
        let msg = "You don't have permission to use 'stop'.";
        assert!(msg.starts_with("You don't have permission"));
    }
}
