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
use mp_control::{BrainDisposer, Subject};

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
        mode: Some(mode),
        options: Some(options),
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

    let result = st.brain.complete(turn_req.clone()).await;

    if execute_tools && !result.tool_proposals.is_empty() {
        let Some(executor) = st.executor.clone() else {
            return (
                StatusCode::CONFLICT,
                Json(json!({ "error": "No bot instance available", "code": "NO_BOT" })),
            )
                .into_response();
        };
        let disposer = BrainDisposer {
            executor,
            rights: st.rights.clone(),
            rights_enabled: st.config.rights_enabled,
        };
        let subj = Subject {
            uid: subject.as_ref().and_then(|s| s.uid.clone()),
            nickname: None,
            server_groups: subject
                .as_ref()
                .and_then(|s| s.server_groups.clone())
                .unwrap_or_default(),
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
        let mut body = serde_json::to_value(&result).unwrap_or(json!({}));
        if let Some(obj) = body.as_object_mut() {
            obj.insert("disposedTools".into(), serde_json::to_value(&disposed).unwrap_or(json!([])));
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
        system_prompt: cfg.llm_system_prompt.clone(),
        temperature: cfg.llm_temperature,
        brain_url: std::env::var("BRAIN_URL").unwrap_or_default(),
        timeout_ms: std::env::var("LLM_TIMEOUT_MS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(180_000),
    }
}
