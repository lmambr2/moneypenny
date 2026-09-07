// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Brain turn contract (`docs/brain-boundary.md`).
//! Brain *proposes*; bot *disposes*. JSON matches Node `POST /v1/turn`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TurnChannel {
    #[default]
    Dashboard,
    Teamspeak,
    Voice,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum TurnMode {
    #[default]
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TurnOptions {
    pub include_sources: Option<bool>,
    pub max_tools: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRequest {
    pub client_turn_id: Option<String>,
    #[serde(default)]
    pub channel: TurnChannel,
    pub text: String,
    pub conversation_id: Option<String>,
    pub subject: Option<TurnSubject>,
    pub mode: Option<TurnMode>,
    pub options: Option<TurnOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSource {
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub classification: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolProposal {
    pub name: String,
    pub arguments: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnResponse {
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_turn_id: Option<String>,
    pub reply_text: String,
    pub sources: Vec<TurnSource>,
    pub tool_proposals: Vec<ToolProposal>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisposedTool {
    pub name: String,
    pub args: serde_json::Value,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum BrainError {
    #[error("brain unavailable: {0}")]
    Unavailable(String),
    #[error("brain timed out")]
    TimedOut,
}

impl BrainError {
    pub fn status_code(&self) -> u16 {
        match self {
            Self::TimedOut => 504,
            Self::Unavailable(_) => 503,
        }
    }
}

pub trait Brain: Send + Sync {
    fn turn(
        &self,
        req: TurnRequest,
    ) -> impl std::future::Future<Output = Result<TurnResponse, BrainError>> + Send;
}

pub fn empty_turn(turn_id: String, req: &TurnRequest, error: impl Into<String>) -> TurnResponse {
    TurnResponse {
        turn_id,
        client_turn_id: req.client_turn_id.clone(),
        reply_text: String::new(),
        sources: Vec::new(),
        tool_proposals: Vec::new(),
        error: Some(error.into()),
    }
}
