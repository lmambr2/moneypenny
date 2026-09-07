// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Remote brain over HTTP POST {baseUrl}/v1/turn.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::types::{
    empty_turn, Brain, BrainError, ToolProposal, TurnRequest, TurnResponse, TurnSource,
};

pub struct RawHttp {
    pub status: u16,
    pub body: Vec<u8>,
}

pub type FetchFn = Arc<
    dyn Fn(String, Value) -> Pin<Box<dyn Future<Output = Result<RawHttp, String>> + Send>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct HttpBrain {
    base_url: String,
    fetch: FetchFn,
}

impl HttpBrain {
    pub fn new(base_url: impl Into<String>, timeout: Duration) -> Self {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .expect("reqwest client");
        let fetch: FetchFn = Arc::new(move |url, body| {
            let client = client.clone();
            Box::pin(async move {
                let res = client
                    .post(&url)
                    .header("content-type", "application/json")
                    .header("accept", "application/json")
                    .json(&body)
                    .send()
                    .await
                    .map_err(|e| {
                        if e.is_timeout() || e.is_connect() {
                            format!("timeout:{e}")
                        } else {
                            e.to_string()
                        }
                    })?;
                let status = res.status().as_u16();
                let body = res.bytes().await.map_err(|e| e.to_string())?.to_vec();
                Ok(RawHttp { status, body })
            })
        });
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            fetch,
        }
    }

    pub fn with_fetch(base_url: impl Into<String>, fetch: FetchFn) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            fetch,
        }
    }
}

impl Brain for HttpBrain {
    async fn turn(&self, req: TurnRequest) -> Result<TurnResponse, BrainError> {
        let url = format!("{}/v1/turn", self.base_url);
        let body = serde_json::to_value(&req).unwrap_or_else(|_| serde_json::json!({}));
        let raw = (self.fetch)(url, body).await.map_err(|e| {
            if e.contains("timeout") || e.contains("timed out") || e.contains("aborted") {
                BrainError::TimedOut
            } else {
                BrainError::Unavailable(format!("Brain transport failed: {e}"))
            }
        })?;
        if raw.status == 504 {
            return Err(BrainError::TimedOut);
        }
        if raw.status == 503 || raw.status >= 500 {
            return Err(BrainError::Unavailable(format!(
                "Brain unavailable ({})",
                raw.status
            )));
        }
        if raw.status == 400 {
            let v: Value = serde_json::from_slice(&raw.body).unwrap_or(Value::Null);
            let err = v
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("invalid turn request");
            return Ok(empty_turn(
                format!("brain-err-{}", now_tag()),
                &req,
                err,
            ));
        }
        if raw.status < 200 || raw.status >= 300 {
            return Err(BrainError::Unavailable(format!("Brain HTTP {}", raw.status)));
        }
        let data: Value = serde_json::from_slice(&raw.body).unwrap_or(Value::Null);
        Ok(normalize_remote(&req, &data))
    }
}

fn now_tag() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| format!("{:x}", d.as_millis()))
        .unwrap_or_else(|_| "0".into())
}

fn normalize_remote(req: &TurnRequest, data: &Value) -> TurnResponse {
    let proposals = data
        .get("toolProposals")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let name = p.get("name")?.as_str()?.to_string();
                    let arguments = p.get("arguments").cloned().unwrap_or(serde_json::json!({}));
                    let arguments = if arguments.is_object() {
                        arguments
                    } else {
                        serde_json::json!({})
                    };
                    let reason = p
                        .get("reason")
                        .and_then(|r| r.as_str())
                        .map(str::to_string);
                    Some(ToolProposal {
                        name,
                        arguments,
                        reason,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let sources = data
        .get("sources")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    let source = s.get("source")?.as_str()?.to_string();
                    Some(TurnSource {
                        source,
                        text: s.get("text").and_then(|t| t.as_str()).map(str::to_string),
                        classification: s
                            .get("classification")
                            .and_then(|t| t.as_str())
                            .map(str::to_string),
                        score: s.get("score").and_then(|t| t.as_f64()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let turn_id = data
        .get("turnId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("brain-remote-{}", now_tag()));
    let client_turn_id = data
        .get("clientTurnId")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| req.client_turn_id.clone());
    let reply_text = data
        .get("replyText")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let error = data
        .get("error")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    TurnResponse {
        turn_id,
        client_turn_id,
        reply_text,
        sources,
        tool_proposals: proposals,
        error,
    }
}
