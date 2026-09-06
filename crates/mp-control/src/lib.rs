// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Deterministic-first router. Rights live in the executor, never the model.
//! COMMAND_MANIFEST names are frozen from `bot/src/bot/commands.ts` at ec464a2.

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_has_skip_play_and_ask() {
        let names = frozen_command_names();
        assert!(names.len() >= 60, "got {}", names.len());
        for n in ["play", "skip", "queue", "ask", "analyst", "radio", "moveall"] {
            assert!(names.iter().any(|x| x == n), "missing {n}");
        }
    }
}
