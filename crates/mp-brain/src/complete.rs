// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use std::time::{SystemTime, UNIX_EPOCH};

use crate::types::{Brain, BrainError, TurnRequest, TurnResponse};

/// Run one brain turn. Maps transport failures to a soft TurnResponse so
/// music/dashboard never crash on brain outage (`softFail` default true).
pub async fn complete_turn(req: TurnRequest, transport: &impl Brain) -> TurnResponse {
    complete_turn_opts(req, transport, true).await
}

pub async fn complete_turn_opts(
    req: TurnRequest,
    transport: &impl Brain,
    soft_fail: bool,
) -> TurnResponse {
    match transport.turn(req.clone()).await {
        Ok(r) => r,
        Err(err) => {
            let msg = match &err {
                BrainError::TimedOut => "Brain timed out".to_string(),
                BrainError::Unavailable(m) => m.clone(),
            };
            if !soft_fail {
                return TurnResponse {
                    turn_id: format!("brain-err-{}", now_tag()),
                    client_turn_id: req.client_turn_id,
                    reply_text: String::new(),
                    sources: Vec::new(),
                    tool_proposals: Vec::new(),
                    error: Some(err.to_string()),
                };
            }
            let turn_id = if matches!(err, BrainError::Unavailable(_)) {
                format!("brain-down-{}", now_tag())
            } else {
                format!("brain-down-{}", now_tag())
            };
            TurnResponse {
                turn_id,
                client_turn_id: req.client_turn_id,
                reply_text: String::new(),
                sources: Vec::new(),
                tool_proposals: Vec::new(),
                error: Some(msg),
            }
        }
    }
}

fn now_tag() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| format!("{:x}", d.as_millis()))
        .unwrap_or_else(|_| "0".into())
}
