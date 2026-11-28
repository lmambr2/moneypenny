// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Admin harness cockpit — same brain path as POST /v1/turn.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::authz::AdminUser;
use crate::bot_api::broadcast_state;
use mp_brain::{
    IntentToolCall, ToolResultTurn, TurnChannel, TurnMode, TurnOptions, TurnRequest, TurnSubject,
    dispose_tool_proposals,
};
use mp_control::Subject;
use mp_db::HarnessTurnRow;

use crate::skills::{self, LoadedSkills};

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
        || st
            .harness_allow_dangerous
            .load(std::sync::atomic::Ordering::SeqCst);

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

    let loaded = if st.data_dir.as_os_str().is_empty() {
        LoadedSkills::default()
    } else {
        skills::load_skills(&st.data_dir.join("skills"))
    };
    let skill = {
        let t = loaded.text.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    };
    let skill_tools = if loaded.declares_tools {
        Some(loaded.tools.clone())
    } else {
        None
    };
    let max_rounds = loaded
        .max_steps
        .filter(|n| *n > 0)
        .map(|n| n.min(4))
        .unwrap_or(4);

    let mut tools: Vec<Value> = Vec::new();
    let mut sources: Vec<Value> = Vec::new();
    let mut reply_parts: Vec<String> = Vec::new();
    let mut last_error: Option<String> = None;
    let mut turn_id = id.clone();
    let mut steps: i64 = 0;
    let user_uid = format!("web:{}", admin.0.id);
    let rank_subject = Subject {
        uid: Some(user_uid.clone()),
        nickname: Some(admin.0.username.clone()),
        server_groups: Vec::new(),
    };
    let (offered, system) = if matches!(mode, TurnMode::Intent) {
        if let Some(executor) = st.executor.clone() {
            let disposer = crate::intent_round::disposer_with_delegate(&st, executor);
            let allows = |cmd: &str| disposer.allows(&rank_subject, cmd);
            let offered = crate::intent_round::offer_intent_tools(
                allows,
                !st.read_config().llm_delegate_url.trim().is_empty(),
                disposer.allows_library(&rank_subject),
            );
            let persona = st.brain.persona().await;
            let system =
                mp_brain::intent_system_prompt_for(&persona, &mp_brain::tool_names(&offered));
            (offered, system)
        } else {
            (Vec::new(), String::new())
        }
    } else {
        (Vec::new(), String::new())
    };
    let mut prior_calls: Vec<IntentToolCall> = Vec::new();
    let mut prior_results: Vec<ToolResultTurn> = Vec::new();
    let mut pending_follow: Option<(Vec<IntentToolCall>, Vec<ToolResultTurn>)> = None;

    for _round in 0..max_rounds {
        if tools.len() >= 8 {
            break;
        }
        let turn_req = TurnRequest {
            client_turn_id: Some(id.clone()),
            channel: TurnChannel::Dashboard,
            text: question.clone(),
            conversation_id: Some("harness-dashboard".into()),
            subject: Some(TurnSubject {
                uid: Some(user_uid.clone()),
                server_groups: Some(Vec::new()),
                allowed_classifications: None,
            }),
            mode: Some(mode.clone()),
            options: Some(TurnOptions {
                include_sources: Some(true),
                max_tools: Some((8 - tools.len()) as u32),
            }),
            skill: skill.clone(),
        };
        let result = if let Some((calls, results)) = pending_follow.take() {
            st.brain
                .complete_follow_up(turn_req, &offered, &system, &calls, &results)
                .await
        } else if matches!(mode, TurnMode::Intent) {
            st.brain
                .complete_with_tools(turn_req, &offered, &system)
                .await
        } else {
            st.brain.complete(turn_req).await
        };
        steps += 1;
        turn_id = result.turn_id;
        if !result.sources.is_empty() {
            sources = serde_json::to_value(&result.sources)
                .ok()
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default();
        }
        if !result.reply_text.trim().is_empty() {
            reply_parts.push(result.reply_text.trim().to_string());
        }
        if result.error.is_some() && result.tool_proposals.is_empty() && tools.is_empty() {
            last_error = result.error;
            break;
        }
        if let Some(err) = result.error.clone() {
            last_error = Some(err);
        }
        if result.tool_proposals.is_empty() {
            break;
        }

        let Some(executor) = st.executor.clone() else {
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
            break;
        };

        let mut allowed = Vec::new();
        let mut blocked = Vec::new();
        for p in result.tool_proposals {
            if let Some(reason) =
                skills::skill_blocks(&p.name, skill_tools.as_ref(), allow_dangerous)
            {
                blocked.push(json!({
                    "name": p.name,
                    "args": p.arguments,
                    "ok": false,
                    "error": reason,
                }));
            } else {
                allowed.push(p);
            }
        }
        let mut round_tools = Vec::new();
        if !allowed.is_empty() {
            let disposer = crate::intent_round::disposer_with_delegate(&st, executor);
            let subj = rank_subject.clone();
            let disposed = dispose_tool_proposals(&allowed, |name, args| {
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
            round_tools.extend(disposed.into_iter().map(|t| {
                json!({
                    "name": t.name,
                    "args": t.args,
                    "ok": t.ok,
                    "result": t.result,
                    "error": t.error,
                })
            }));
        }
        round_tools.extend(blocked);
        let follow = !allowed.is_empty();
        tools.extend(round_tools.iter().cloned());
        if !follow {
            break;
        }
        let calls: Vec<IntentToolCall> = round_tools
            .iter()
            .enumerate()
            .map(|(i, t)| IntentToolCall {
                id: format!("call-{steps}-{i}"),
                name: t
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string(),
                arguments: t.get("args").cloned().unwrap_or(json!({})),
            })
            .collect();
        let results: Vec<ToolResultTurn> = round_tools
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let content = t
                    .get("result")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .or_else(|| t.get("error").and_then(|v| v.as_str()).map(str::to_string))
                    .unwrap_or_else(|| "(no result)".into());
                ToolResultTurn {
                    id: format!("call-{steps}-{i}"),
                    content,
                }
            })
            .collect();
        prior_calls.extend(calls);
        prior_results.extend(results);
        pending_follow = Some((prior_calls.clone(), prior_results.clone()));
    }

    for t in &tools {
        if let Some(r) = t
            .get("result")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            reply_parts.push(r.to_string());
        } else if let Some(e) = t
            .get("error")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            reply_parts.push(format!(
                "{}: {e}",
                t.get("name").and_then(|v| v.as_str()).unwrap_or("tool")
            ));
        }
    }
    let reply = if reply_parts.is_empty() {
        if !tools.is_empty() {
            "(tools ran; no text)".into()
        } else if last_error.is_some() {
            String::new()
        } else {
            "(no response)".into()
        }
    } else {
        reply_parts.join("\n")
    };
    let mode_name = if matches!(mode, TurnMode::Intent) {
        "intent"
    } else {
        "ask"
    };

    let mut turn = json!({
        "id": turn_id,
        "at": at,
        "user": question,
        "reply": reply,
        "sources": sources,
        "tools": tools,
        "mode": mode_name,
    });
    if let Some(err) = last_error.clone() {
        turn.as_object_mut()
            .unwrap()
            .insert("error".into(), json!(err));
    }
    st.harness.push(turn.clone());
    if !question.is_empty() {
        let row = HarnessTurnRow {
            id: turn_id,
            at,
            channel: "dashboard".into(),
            conversation_id: Some("harness-dashboard".into()),
            user_uid: Some(user_uid),
            mode: mode_name.into(),
            user_text: question,
            reply_text: reply,
            tools_json: serde_json::to_string(&tools).unwrap_or_else(|_| "[]".into()),
            sources_json: serde_json::to_string(&sources).unwrap_or_else(|_| "[]".into()),
            error: last_error,
            steps,
        };
        if let Err(e) = st.db.insert_harness_turn(&row) {
            tracing::warn!(error = %e, "harness turn was not stored");
        }
    }
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
