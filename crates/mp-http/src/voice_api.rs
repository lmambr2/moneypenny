// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! GET /api/bot/voice/status + POST /api/bot/voice/test (admin).

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::authz::AdminUser;
use crate::command::dispatch_command;
use crate::AppState;
use mp_control::{is_known_command, parse_command};
use mp_rights::{Scope, Subject};
use mp_voice::TranscriptOpts;

pub async fn voice_status(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let status = st.voice.status().await;
    Json(serde_json::to_value(status).unwrap_or_else(|_| json!({})))
}

#[derive(Deserialize)]
pub struct VoiceTestBody {
    transcript: Option<String>,
    speak: Option<bool>,
}

pub async fn voice_test(
    State(st): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<VoiceTestBody>,
) -> Response {
    let transcript = body.transcript.unwrap_or_default().trim().to_string();
    if transcript.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"transcript is required","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    if !st.voice.is_active() {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "Voice pipeline is not active — enable voice in Settings and ensure STT URL is set",
                "code": "VOICE_UNAVAILABLE"
            })),
        )
            .into_response();
    }
    let Some(executor) = st.executor.clone() else {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"No bot instance available","code":"NO_BOT"})),
        )
            .into_response();
    };
    let speak = body.speak.unwrap_or(false);
    let prefix = executor.prefix.clone();
    let aliases = st.config.command_aliases.clone();
    let db = Arc::clone(&st.db);
    let brain = Arc::clone(&st.brain);
    let rag = st.rag.clone();
    let rights = st.rights.clone();

    let turn = st
        .voice
        .handle_transcript(
            &transcript,
            0,
            TranscriptOpts {
                speak: Some(speak),
                text_wake_fallback: Some(true),
                ..Default::default()
            },
            |cmd| {
                let executor = executor.clone();
                let db = Arc::clone(&db);
                let brain = Arc::clone(&brain);
                let rag = rag.clone();
                let rights = rights.clone();
                let prefix = prefix.clone();
                let aliases = aliases.clone();
                async move {
                    let parsed = parse_command(&format!("{prefix}{cmd}"), &prefix, &aliases)?;
                    if !is_known_command(&parsed.name) {
                        return None;
                    }
                    let subject = Subject {
                        uid: "voice-smoke-test".into(),
                        server_groups: Vec::new(),
                        nickname: Some("voice-smoke-test".into()),
                    };
                    dispatch_command(
                        &parsed,
                        &subject,
                        Scope::Voice,
                        &executor,
                        rights.as_deref(),
                        &db,
                        &brain,
                        rag.as_deref(),
                        None,
                    )
                    .await
                }
            },
        )
        .await;

    Json(json!({
        "transcript": transcript,
        "reply": turn.reply,
        "ttsBytes": turn.tts_bytes,
        "watchwordOnly": turn.watchword_only,
        "command": turn.command,
    }))
    .into_response()
}
