// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Brain turn contract (`docs/brain-boundary.md`).
//! Brain *proposes*; bot *disposes*. Phase 4 implements the HTTP client.
//!
//! `TurnRequest` / `TurnResponse` JSON must match existing `POST /v1/turn`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TurnChannel {
    Dashboard,
    Teamspeak,
    Voice,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TurnMode {
    Ask,
    Intent,
    Delegate,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TurnSubject {
    pub uid: Option<String>,
    pub server_groups: Option<Vec<String>>,
    pub allowed_classifications: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRequest {
    pub client_turn_id: Option<String>,
    pub channel: TurnChannel,
    pub text: String,
    pub conversation_id: Option<String>,
    pub subject: Option<TurnSubject>,
    pub mode: Option<TurnMode>,
    pub execute_tools: Option<bool>,
    pub dry_run: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSource {
    pub source: String,
    pub text: Option<String>,
    pub classification: Option<String>,
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolProposal {
    pub name: String,
    pub arguments: serde_json::Value,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnResponse {
    pub turn_id: String,
    pub client_turn_id: Option<String>,
    pub reply_text: String,
    pub sources: Vec<TurnSource>,
    pub tool_proposals: Vec<ToolProposal>,
    pub error: Option<String>,
}

pub trait Brain: Send + Sync {
    fn turn(
        &self,
        req: TurnRequest,
    ) -> impl std::future::Future<Output = Result<TurnResponse, BrainError>> + Send;
}

#[derive(Debug, thiserror::Error)]
pub enum BrainError {
    #[error("brain unavailable: {0}")]
    Unavailable(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_json_camel_case() {
        let req = TurnRequest {
            client_turn_id: Some("c1".into()),
            channel: TurnChannel::Dashboard,
            text: "skip".into(),
            conversation_id: None,
            subject: None,
            mode: Some(TurnMode::Intent),
            execute_tools: Some(false),
            dry_run: Some(true),
        };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["clientTurnId"], "c1");
        assert_eq!(v["executeTools"], false);
        assert_eq!(v["dryRun"], true);
        assert_eq!(v["channel"], "dashboard");
    }
}
