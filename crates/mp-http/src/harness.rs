// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Admin harness cockpit — same brain path as POST /v1/turn.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::authz::AdminUser;
use crate::bot_api::broadcast_state;
use crate::AppState;
use mp_brain::{
    dispose_tool_proposals, TurnChannel, TurnMode, TurnOptions, TurnRequest, TurnSubject,
};
use mp_control::{BrainDisposer, Subject};

const HARNESS_CAP: usize = 50;

#[derive(Default)]
pub struct HarnessStore {
    turns: Mutex<VecDeque<Value>>,
}

impl HarnessStore {
    pub fn push(&self, turn: Value) {
        let mut g = self.turns.lock().expect("harness");
        g.push_front(turn);
        while g.len() > HARNESS_CAP {
            g.pop_back();
        }
    }

    pub fn list(&self, limit: usize) -> Vec<Value> {
        self.turns
            .lock()
            .expect("harness")
            .iter()
            .take(limit.clamp(1, 50))
            .cloned()
            .collect()
    }
}

#[derive(Deserialize)]
pub struct AskBody {
    question: Option<String>,
    q: Option<String>,
    mode: Option<String>,
    #[serde(default)]
    dry_run: Option<bool>,
    #[serde(rename = "dryRun")]
    dry_run_alias: Option<bool>,
    #[serde(default)]
    allow_dangerous: Option<bool>,
    #[serde(rename = "allowDangerous")]
    allow_dangerous_alias: Option<bool>,
}

pub async fn harness_ask(
    State(st): State<AppState>,
    admin: AdminUser,
    Json(body): Json<AskBody>,
) -> Response {
    let question = body
        .question
        .or(body.q)
        .unwrap_or_default()
        .trim()
        .to_string();
    if question.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"question is required","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    let mode = if body.mode.as_deref() == Some("intent") {
        TurnMode::Intent
    } else {
        TurnMode::Ask
    };
    let dry_run = body.dry_run.or(body.dry_run_alias).unwrap_or(false);
    let allow_dangerous = body
        .allow_dangerous
        .or(body.allow_dangerous_alias)
        .unwrap_or(false)
        || st.harness_allow_dangerous.load(std::sync::atomic::Ordering::SeqCst);

    let id = format!(
        "h-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let (enabled, _, _) = st.brain.llm_snapshot().await;
    if !enabled {
        let turn = json!({
            "id": id,
            "at": at,
            "user": question,
            "reply": "",
            "sources": [],
            "tools": [],
            "error": "LLM is not enabled",
            "mode": if matches!(mode, TurnMode::Intent) { "intent" } else { "ask" },
        });
        st.harness.push(turn.clone());
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"LLM is not enabled","code":"LLM_DISABLED","turn": turn})),
        )
            .into_response();
    }

    let turn_req = TurnRequest {
        client_turn_id: Some(id.clone()),
        channel: TurnChannel::Dashboard,
        text: question.clone(),
        conversation_id: Some("harness-dashboard".into()),
        subject: Some(TurnSubject {
            uid: Some(format!("web:{}", admin.0.id)),
            server_groups: Some(Vec::new()),
            allowed_classifications: None,
        }),
        mode: Some(mode.clone()),
        options: Some(TurnOptions {
            include_sources: Some(true),
            max_tools: Some(8),
        }),
    };
    let result = st.brain.complete(turn_req).await;

    let mut tools: Vec<Value> = Vec::new();
    if !result.tool_proposals.is_empty() {
        if let Some(executor) = st.executor.clone() {
            let disposer = BrainDisposer {
                executor,
                rights: st.rights.clone(),
                rights_enabled: st.config.rights_enabled,
            };
            let subj = Subject {
                uid: Some(format!("web:{}", admin.0.id)),
                nickname: Some(admin.0.username.clone()),
                server_groups: Vec::new(),
            };
            let disposed = dispose_tool_proposals(&result.tool_proposals, |name, args| {
                let disposer = disposer.clone();
                let subj = subj.clone();
                async move {
                    let rec = disposer
                        .dispose_tool(&name, &args, &subj, dry_run, allow_dangerous)
                        .await;
                    Ok((rec.ok, rec.result, rec.error))
                }
            })
            .await;
            if !dry_run {
                broadcast_state(&st);
            }
            tools = disposed
                .into_iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "args": t.args,
                        "ok": t.ok,
                        "result": t.result,
                        "error": t.error,
                    })
                })
                .collect();
        } else {
            tools = result
                .tool_proposals
                .iter()
                .map(|p| {
                    json!({
                        "name": p.name,
                        "args": p.arguments,
                        "ok": false,
                        "error": "no tool executor",
                    })
                })
                .collect();
        }
    }

    let mut reply_parts = Vec::new();
    if !result.reply_text.trim().is_empty() {
        reply_parts.push(result.reply_text.trim().to_string());
    }
    for t in &tools {
        if let Some(r) = t.get("result").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            reply_parts.push(r.to_string());
        } else if let Some(e) = t.get("error").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            reply_parts.push(format!("{}: {e}", t.get("name").and_then(|v| v.as_str()).unwrap_or("tool")));
        }
    }
    let reply = if reply_parts.is_empty() {
        if !tools.is_empty() {
            "(tools ran; no text)".into()
        } else if result.error.is_some() {
            String::new()
        } else {
            "(no response)".into()
        }
    } else {
        reply_parts.join("\n")
    };

    let mut turn = json!({
        "id": result.turn_id,
        "at": at,
        "user": question,
        "reply": reply,
        "sources": result.sources,
        "tools": tools,
        "mode": if matches!(mode, TurnMode::Intent) { "intent" } else { "ask" },
    });
    if let Some(err) = result.error {
        turn.as_object_mut()
            .unwrap()
            .insert("error".into(), json!(err));
    }
    st.harness.push(turn.clone());
    Json(json!({ "turn": turn })).into_response()
}

#[derive(Deserialize)]
pub struct TurnsQuery {
    limit: Option<u32>,
}

pub async fn harness_turns(
    State(st): State<AppState>,
    _admin: AdminUser,
    Query(q): Query<TurnsQuery>,
) -> Json<Value> {
    let limit = q.limit.unwrap_or(30).clamp(1, 50) as usize;
    Json(json!({ "turns": st.harness.list(limit) }))
}
