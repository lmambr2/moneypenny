// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! `POST /v1/turn` — admin session. Brain proposes; optional `executeTools` disposes.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::authz::AdminUser;
use crate::bot_api::broadcast_state;
use crate::AppState;
use mp_brain::{
    dispose_tool_proposals, TurnChannel, TurnMode, TurnOptions, TurnRequest, TurnSubject,
};
use mp_control::Subject;

pub async fn turn(
    State(st): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<Value>,
) -> Response {
    let text = body
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "text is required" })))
            .into_response();
    }

    let mode = match body.get("mode").and_then(|v| v.as_str()) {
        Some("intent") => TurnMode::Intent,
        Some("delegate") => TurnMode::Delegate,
        _ => TurnMode::Ask,
    };
    let channel = match body.get("channel").and_then(|v| v.as_str()) {
        Some("teamspeak") => TurnChannel::Teamspeak,
        Some("voice") => TurnChannel::Voice,
        _ => TurnChannel::Dashboard,
    };

    let subject = body.get("subject").and_then(|s| {
        if !s.is_object() {
            return None;
        }
        Some(TurnSubject {
            uid: s.get("uid").and_then(|v| v.as_str()).map(str::to_string),
            server_groups: s.get("serverGroups").and_then(|v| v.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|g| g.as_str().map(str::to_string))
                    .collect()
            }),
            allowed_classifications: s
                .get("allowedClassifications")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|g| g.as_str().map(str::to_string))
                        .collect()
                }),
        })
    });

    let options = TurnOptions {
        include_sources: Some(
            body.get("options")
                .and_then(|o| o.get("includeSources"))
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
        ),
        max_tools: body
            .get("options")
            .and_then(|o| o.get("maxTools"))
            .and_then(|v| v.as_u64())
            .map(|n| n as u32),
    };

    let turn_req = TurnRequest {
        client_turn_id: body
            .get("clientTurnId")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        channel,
        text,
        conversation_id: body
            .get("conversationId")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        subject: subject.clone(),
        mode: Some(mode.clone()),
        options: Some(options),
        skill: body
            .get("skill")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    };

    let execute_tools = body.get("executeTools").and_then(|v| v.as_bool()) == Some(true);
    let dry_run = body.get("dryRun").and_then(|v| v.as_bool()) == Some(true);
    let allow_dangerous = body.get("allowDangerous").and_then(|v| v.as_bool()) == Some(true);

    if execute_tools && st.executor.is_none() {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "No bot instance available", "code": "NO_BOT" })),
        )
            .into_response();
    }

    let rank_subject = Subject {
        uid: subject.as_ref().and_then(|s| s.uid.clone()),
        nickname: None,
        server_groups: subject
            .as_ref()
            .and_then(|s| s.server_groups.clone())
            .unwrap_or_default(),
    };
    let scope = if turn_req.channel == TurnChannel::Voice {
        mp_rights::Scope::Voice
    } else {
        mp_rights::Scope::Chat
    };
    if mode == TurnMode::Delegate
        && !crate::intent_round::subject_can_analyst(&st, &rank_subject, scope)
    {
        let denied = mp_brain::TurnResponse {
            turn_id: "denied".into(),
            client_turn_id: turn_req.client_turn_id.clone(),
            reply_text: mp_brain::ANALYST_DENIED.into(),
            sources: Vec::new(),
            tool_proposals: Vec::new(),
            error: None,
        };
        return Json(denied).into_response();
    }

    let (offered, system) = if mode == TurnMode::Intent {
        if let Some(executor) = st.executor.clone() {
            let disposer = crate::intent_round::disposer_with_delegate(&st, executor);
            let allows = |cmd: &str| disposer.allows(&rank_subject, cmd);
            let offered = crate::intent_round::offer_intent_tools(
                allows,
                !st.config.llm_delegate_url.trim().is_empty(),
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

    let mut result = if mode == TurnMode::Intent && st.executor.is_some() {
        st.brain
            .complete_with_tools(turn_req.clone(), &offered, &system)
            .await
    } else {
        st.brain.complete(turn_req.clone()).await
    };

    if execute_tools && !result.tool_proposals.is_empty() {
        let Some(mut disposed) = dispose_round(
            &st,
            &result.tool_proposals,
            &rank_subject,
            dry_run,
            allow_dangerous,
        )
        .await
        else {
            return (
                StatusCode::CONFLICT,
                Json(json!({ "error": "No bot instance available", "code": "NO_BOT" })),
            )
                .into_response();
        };
        if mode == TurnMode::Intent {
            let (calls, results) = follow_parts(&result.tool_proposals, &disposed);
            let follow = st
                .brain
                .complete_follow_up(turn_req, &offered, &system, &calls, &results)
                .await;
            if !follow.reply_text.trim().is_empty() {
                result.reply_text = follow.reply_text;
            }
            if !follow.tool_proposals.is_empty() {
                if let Some(more) = dispose_round(
                    &st,
                    &follow.tool_proposals,
                    &rank_subject,
                    dry_run,
                    allow_dangerous,
                )
                .await
                {
                    disposed.extend(more);
                }
            }
        }
        let mut body = serde_json::to_value(&result).unwrap_or(json!({}));
        if let Some(obj) = body.as_object_mut() {
            obj.insert(
                "disposedTools".into(),
                serde_json::to_value(&disposed).unwrap_or(json!([])),
            );
        }
        return Json(body).into_response();
    }

    if result.error.as_deref() == Some("LLM is not enabled") {
        let mut body = serde_json::to_value(&result).unwrap_or(json!({}));
        if let Some(obj) = body.as_object_mut() {
            obj.insert("code".into(), json!("LLM_DISABLED"));
        }
        return (StatusCode::CONFLICT, Json(body)).into_response();
    }

    Json(serde_json::to_value(&result).unwrap_or(json!({}))).into_response()
}

pub fn llm_settings_from(cfg: &mp_config::BotConfig) -> mp_brain::LlmSettings {
    mp_brain::LlmSettings {
        enabled: cfg.llm_enabled,
        url: cfg.llm_url.clone(),
        model: cfg.llm_model.clone(),
        fallback_url: cfg.llm_fallback_url.clone(),
        fallback_model: cfg.llm_fallback_model.clone(),
        delegate_url: cfg.llm_delegate_url.clone(),
        delegate_model: cfg.llm_delegate_model.clone(),
        system_prompt: cfg.llm_system_prompt.clone(),
        temperature: cfg.llm_temperature,
        brain_url: std::env::var("BRAIN_URL").unwrap_or_default(),
        timeout_ms: std::env::var("LLM_TIMEOUT_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(180_000),
    }
}

async fn dispose_round(
    st: &AppState,
    proposals: &[mp_brain::ToolProposal],
    subject: &Subject,
    dry_run: bool,
    allow_dangerous: bool,
) -> Option<Vec<mp_brain::DisposedTool>> {
    let executor = st.executor.clone()?;
    let disposer = crate::intent_round::disposer_with_delegate(st, executor);
    let disposed = dispose_tool_proposals(proposals, |name, args| {
        let disposer = disposer.clone();
        let subj = subject.clone();
        async move {
            let rec = disposer
                .dispose_tool(&name, &args, &subj, dry_run, allow_dangerous)
                .await;
            Ok((rec.ok, rec.result, rec.error))
        }
    })
    .await;
    if !dry_run {
        broadcast_state(st);
    }
    Some(disposed)
}

fn follow_parts(
    proposals: &[mp_brain::ToolProposal],
    disposed: &[mp_brain::DisposedTool],
) -> (Vec<mp_brain::IntentToolCall>, Vec<mp_brain::ToolResultTurn>) {
    let mut calls = Vec::new();
    let mut results = Vec::new();
    for (i, (proposal, record)) in proposals.iter().zip(disposed.iter()).enumerate() {
        let id = proposal
            .id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("call-1-{i}"));
        calls.push(mp_brain::IntentToolCall {
            id: id.clone(),
            name: record.name.clone(),
            arguments: record.args.clone(),
        });
        let content = record
            .result
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| record.error.clone())
            .unwrap_or_else(|| "(no result)".into());
        results.push(mp_brain::ToolResultTurn { id, content });
    }
    (calls, results)
}
