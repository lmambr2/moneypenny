// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! `/api/bot` — list/status/settings/live. Multi-bot CRUD stays a stub.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::authz::{AdminUser, AuthUser};
use crate::json_song::queued_json;
use crate::AppState;
use mp_music::PlayerState;

pub fn bot_status_json(st: &AppState) -> Value {
    let (connected, playing, paused, current, queue_size, volume, play_mode, elapsed) =
        if let Some(station) = st.station.as_ref() {
            let q = station.queue.lock().expect("queue");
            let state = station.player.get_state();
            (
                station.is_connected(),
                state == PlayerState::Playing,
                state == PlayerState::Paused,
                q.current().map(|s| queued_json(&s)),
                q.size(),
                station.player.get_volume(),
                q.get_mode().as_str().to_string(),
                station.player.get_elapsed(),
            )
        } else {
            (false, false, false, None, 0, 30, "rloop".into(), 0.0)
        };
    json!({
        "id": st.bot_id,
        "name": st.bot_name,
        "connected": connected,
        "playing": playing,
        "paused": paused,
        "currentSong": current,
        "queueSize": queue_size,
        "volume": volume,
        "playMode": play_mode,
        "elapsed": elapsed,
    })
}

pub fn queue_json(st: &AppState) -> Vec<Value> {
    st.station
        .as_ref()
        .map(|s| {
            s.queue
                .lock()
                .expect("queue")
                .list()
                .iter()
                .map(queued_json)
                .collect()
        })
        .unwrap_or_default()
}

pub fn broadcast_state(st: &AppState) {
    let _ = st.ws_tx.send(json!({
        "type": "stateChange",
        "botId": st.bot_id,
        "status": bot_status_json(st),
        "queue": queue_json(st),
    }));
}

pub async fn list_bots(State(st): State<AppState>, _user: AuthUser) -> Json<Value> {
    Json(json!({ "bots": [bot_status_json(&st)] }))
}

pub async fn get_bot(
    State(st): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    if id != st.bot_id {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"Bot not found"}))).into_response();
    }
    Json(bot_status_json(&st)).into_response()
}

pub async fn live(State(st): State<AppState>, _user: AuthUser) -> Json<Value> {
    Json(live_status(&st))
}

pub fn live_status(st: &AppState) -> Value {
    let connected = st.station.as_ref().is_some_and(|s| s.is_connected());
    let (now, queue) = if let Some(station) = st.station.as_ref() {
        let q = station.queue.lock().expect("queue");
        let cur = q.current();
        let now = cur.as_ref().map(|s| json!({ "name": s.name, "artist": s.artist }));
        let queue: Vec<Value> = q
            .list()
            .iter()
            .take(20)
            .map(|s| json!({ "name": s.name, "artist": s.artist }))
            .collect();
        (now, queue)
    } else {
        (None, Vec::new())
    };
    let mut feedback = Vec::new();
    feedback.push(if connected {
        "TeamSpeak connected."
    } else {
        "TeamSpeak offline."
    });
    feedback.push("Radio off.");
    if let Some(n) = now.as_ref() {
        feedback.push("Playing.");
        let _ = n;
    } else if queue.is_empty() {
        feedback.push("Queue empty — !play or enable radio.");
    } else {
        feedback.push("Queue has tracks waiting.");
    }
    feedback.push("Voice loop off.");
    feedback.push("Doctrine RAG off.");
    json!({
        "connected": connected,
        "nowPlaying": now,
        "queue": queue,
        "radio": null,
        "voice": { "enabled": false, "duckOnSpeech": true },
        "rag": { "enabled": false },
        "feedback": feedback,
        "scope": {
            "serverLabel": "",
            "channelHint": null,
            "channelPinned": false,
        }
    })
}

pub async fn settings_get(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let c = &st.config;
    let (llm_enabled, llm_url, llm_model) = st.brain.llm_snapshot().await;
    Json(json!({
        "idleTimeoutMinutes": 0,
        "llmEnabled": llm_enabled,
        "llmUrl": llm_url,
        "llmModel": llm_model,
        "llmFallbackUrl": c.llm_fallback_url,
        "llmFallbackModel": c.llm_fallback_model,
        "llmDelegateUrl": "",
        "llmDelegateModel": "",
        "llmSystemPrompt": "",
        "llmTemperature": 0.2,
        "roastEnabled": false,
        "roastMinPresent": 3,
        "roastCooldownMinutes": 180,
        "roastMinScore": 4,
        "youtubeSaveEnabled": false,
        "musicOpusBitrateKbps": c.music_opus_bitrate_kbps,
        "musicBlockedGenres": c.music_blocked_genres,
        "autoFollowEnabled": false,
        "autoFollowCooldownSec": 60,
        "ragEnabled": false,
        "ragTopK": 6,
        "memoryEnabled": false,
        "kgEnabled": false,
        "mempalaceEnabled": false,
        "mempalaceUrl": "",
        "scOrgStatusUrl": "",
        "scOrgName": "",
        "aceStepEnabled": false,
        "aceStepUrl": "",
        "aceStepAutoFill": false,
        "aceStepTimeoutMs": 300000,
        "aceStepOutputDir": "generated/ace-step",
        "aceStepMaxFiles": 40,
        "fileDropEnabled": false,
        "fileDropPollSec": 30,
        "rightsEnabled": c.rights_enabled,
        "adminGroups": c.admin_groups,
        "rights": c.rights,
        "streamBridgeUrl": "",
        "pokeCommandsEnabled": c.poke_commands_enabled,
        "pokeCommandsPerMinute": 12,
        "trustProxy": c.trust_proxy,
        "trustProxyHops": c.trust_proxy_hops,
        "scope": { "channelHint": "", "serverLabel": "", "virtualServerId": "" },
        "harnessIntentAllowDangerous": false,
        "recordingsEnabled": false,
        "voice": { "enabled": false, "duckMusicOnSpeech": true },
        "radio": { "enabled": false, "activeProfile": "default" },
        "vectorDbUrl": "",
        "embeddingUrl": c.embedding_url,
        "embeddingModel": c.embedding_model,
        "ragCollection": "moneypenny_docs",
    }))
}

pub async fn settings_post(
    State(st): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<Value>,
) -> Json<Value> {
    if let Some(kbps) = body.get("musicOpusBitrateKbps").and_then(|v| v.as_i64()) {
        if let Some(station) = st.station.as_ref() {
            station.player.set_bitrate_kbps(kbps as i32);
        }
    }
    if body.get("llmEnabled").is_some()
        || body.get("llmUrl").is_some()
        || body.get("llmModel").is_some()
        || body.get("llmSystemPrompt").is_some()
        || body.get("llmTemperature").is_some()
        || body.get("llmFallbackUrl").is_some()
        || body.get("llmFallbackModel").is_some()
    {
        st.brain
            .update_llm(
                body.get("llmEnabled").and_then(|v| v.as_bool()),
                body.get("llmUrl").and_then(|v| v.as_str()).map(str::to_string),
                body.get("llmModel").and_then(|v| v.as_str()).map(str::to_string),
                body.get("llmSystemPrompt")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                body.get("llmTemperature")
                    .and_then(|v| v.as_f64())
                    .map(|n| n as f32),
                body.get("llmFallbackUrl")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                body.get("llmFallbackModel")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            )
            .await;
    }
    Json(json!({ "ok": true }))
}

pub async fn start_bot(
    State(st): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<String>,
) -> Response {
    if id != st.bot_id {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"Bot not found"}))).into_response();
    }
    Json(json!({ "ok": true, "message": "already managed by TS6_HOST" })).into_response()
}

pub async fn stop_bot(
    State(st): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<String>,
) -> Response {
    if id != st.bot_id {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"Bot not found"}))).into_response();
    }
    Json(json!({ "ok": true, "message": "stop is a process restart in the rust runtime" })).into_response()
}

pub async fn bot_config(
    State(st): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<String>,
) -> Response {
    if id != st.bot_id {
        return (StatusCode::NOT_FOUND, Json(json!({"error":"Bot config not found"}))).into_response();
    }
    Json(json!({
        "id": st.bot_id,
        "name": st.bot_name,
        "serverAddress": std::env::var("TS6_HOST").unwrap_or_default(),
        "serverPort": std::env::var("TS6_PORT").ok().and_then(|s| s.parse::<u16>().ok()).unwrap_or(9987),
        "nickname": st.bot_name,
        "defaultChannel": std::env::var("DEFAULT_CHANNEL").unwrap_or_default(),
        "autoStart": true,
        "serverProtocol": "ts6",
    }))
    .into_response()
}

pub async fn create_bot(_admin: AdminUser) -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({"error":"multi-bot create not ported (single rust process)"})),
    )
        .into_response()
}

pub async fn delete_bot(_admin: AdminUser) -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({"error":"multi-bot delete not ported"})),
    )
        .into_response()
}

pub async fn recordings_list(_user: AuthUser) -> Json<Value> {
    Json(json!({ "enabled": false, "recordings": [] }))
}
