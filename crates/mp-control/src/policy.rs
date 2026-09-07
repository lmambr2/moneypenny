// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Harness intent tool policy (`bot/src/harness/tool-policy.ts`).
//! Safer default allowlist; dry-run skips the executor entirely.

use std::collections::HashSet;

pub const HARNESS_SAFE_TOOLS: &[&str] = &[
    "play_music",
    "queue",
    "select_tracks",
    "skip",
    "pause",
    "resume",
    "now_playing",
];

pub const HARNESS_DANGEROUS_TOOLS: &[&str] = &[
    "stop",
    "set_volume",
    "move_client",
    "move_all_clients",
    "delegate_to_agent",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HarnessToolDecision {
    Execute,
    DryRun,
    Block { reason: String },
}

pub fn decide_harness_tool(
    tool_name: &str,
    dry_run: bool,
    allow_dangerous: bool,
    allowlist: Option<&[String]>,
) -> HarnessToolDecision {
    if dry_run {
        return HarnessToolDecision::DryRun;
    }
    let allowed: HashSet<&str> = if let Some(list) = allowlist {
        list.iter().map(String::as_str).collect()
    } else if allow_dangerous {
        HARNESS_SAFE_TOOLS
            .iter()
            .chain(HARNESS_DANGEROUS_TOOLS.iter())
            .copied()
            .collect()
    } else {
        HARNESS_SAFE_TOOLS.iter().copied().collect()
    };
    if !allowed.contains(tool_name) {
        let reason = if allow_dangerous {
            format!("tool not allowed: {tool_name}")
        } else {
            format!(
                "tool blocked by harness safety policy (enable allowDangerous for stop/vol/move): {tool_name}"
            )
        };
        return HarnessToolDecision::Block { reason };
    }
    HarnessToolDecision::Execute
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dry_run_short_circuits() {
        assert_eq!(
            decide_harness_tool("stop", true, false, None),
            HarnessToolDecision::DryRun
        );
    }

    #[test]
    fn safe_tools_execute() {
        assert_eq!(
            decide_harness_tool("play_music", false, false, None),
            HarnessToolDecision::Execute
        );
    }

    #[test]
    fn stop_blocked_without_dangerous() {
        match decide_harness_tool("stop", false, false, None) {
            HarnessToolDecision::Block { reason } => {
                assert!(reason.contains("allowDangerous"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn stop_ok_with_dangerous() {
        assert_eq!(
            decide_harness_tool("stop", false, true, None),
            HarnessToolDecision::Execute
        );
    }
}
