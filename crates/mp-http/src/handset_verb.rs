// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Direct music verbs and now-playing. No model call. The eight names go
//! through `tool_call_to_command` and `executor.execute`. The flight lock and
//! the turn map are the same ones typed chat uses. A verb skips the 20 s
//! deadline: the spawned task holds the guard until the finished body is stored.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{OwnedMutexGuard, oneshot};
use tracing::Instrument;

use crate::AppState;
use crate::handset_auth::HandsetUser;
use mp_music::PlayerState;

const TURN_ID_MAX: usize = 64;
const QUERY_MAX: usize = 200;
const NOT_ON_TS: &str = "Bot is not connected to TeamSpeak";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VerbBody {
    name: String,
    #[serde(rename = "clientTurnId")]
    client_turn_id: String,
    level: Option<Value>,
    query: Option<Value>,
    source: Option<Value>,
}

struct Prepared {
    name: String,
    client_turn_id: String,
    command: mp_control::ParsedCommand,
}

pub(crate) async fn verb(
    State(st): State<AppState>,
    user: HandsetUser,
    body: axum::body::Bytes,
) -> Response {
    let span = tracing::info_span!("handset.verb", device_id = %user.id);
    async move { handle_verb(st, user, body).await }
        .instrument(span)
        .await
}

async fn handle_verb(st: AppState, user: HandsetUser, body: axum::body::Bytes) -> Response {
    let prepared = match prepare(&body) {
        Ok(prepared) => prepared,
        Err(res) => return res,
    };
    if st.station.is_none() || st.executor.is_none() {
        return coded(StatusCode::CONFLICT, "No bot instance available", "NO_BOT");
    }

    let Ok(guard) = Arc::clone(&st.handset_flight).try_lock_owned() else {
        return coded(StatusCode::CONFLICT, "handset busy", "BUSY");
    };
    if let Some((status, stored)) = st.handset_turns.lookup(&user.id, &prepared.client_turn_id) {
        drop(guard);
        return stored_response(status, stored);
    }

    let (tx, rx) = oneshot::channel();
    let task_span = tracing::Span::current();
    let device_id = user.id.clone();
    let st_task = st.clone();
    tokio::spawn(
        async move {
            finish_verb(st_task, guard, device_id, prepared, tx).await;
        }
        .instrument(task_span),
    );

    match rx.await {
        Ok((status, body)) => stored_response(status, body),
        Err(_) => coded(
            StatusCode::INTERNAL_SERVER_ERROR,
            "handset failed",
            "HANDSET_FAILED",
        ),
    }
}

async fn finish_verb(
    st: AppState,
    guard: OwnedMutexGuard<()>,
    device_id: String,
    prepared: Prepared,
    tx: oneshot::Sender<(u16, Value)>,
) {
    if !st.handset_dispose_delay.is_zero() {
        tokio::time::sleep(st.handset_dispose_delay).await;
    }
    let Some(executor) = st.executor.clone() else {
        drop(guard);
        let _ = tx.send((
            500,
            json!({"error": "handset failed", "code": "HANDSET_FAILED"}),
        ));
        return;
    };
    let executed = executor.execute(&prepared.command).await;
    let Some(result) = executed else {
        drop(guard);
        let _ = tx.send((
            500,
            json!({"error": "handset failed", "code": "HANDSET_FAILED"}),
        ));
        return;
    };

    let (status, body, ran) = if result == NOT_ON_TS {
        (
            409,
            json!({
                "name": prepared.name,
                "clientTurnId": prepared.client_turn_id,
                "error": NOT_ON_TS,
                "code": "NOT_ON_TEAMSPEAK",
            }),
            false,
        )
    } else if result.starts_with("Usage:") {
        (
            200,
            json!({
                "name": prepared.name,
                "clientTurnId": prepared.client_turn_id,
                "ok": false,
                "result": null,
                "error": "bad tool arguments",
            }),
            true,
        )
    } else {
        (
            200,
            json!({
                "name": prepared.name,
                "clientTurnId": prepared.client_turn_id,
                "ok": true,
                "result": result,
            }),
            true,
        )
    };
    if ran {
        crate::bot_api::broadcast_state(&st);
    }
    st.handset_turns
        .insert(&device_id, &prepared.client_turn_id, status, body.clone());
    drop(guard);
    let _ = tx.send((status, body));
    tracing::info!(tool = %prepared.name, status, "handset verb finished");
}

fn prepare(body: &[u8]) -> Result<Prepared, Response> {
    let parsed: VerbBody = match serde_json::from_slice(body) {
        Ok(parsed) => parsed,
        Err(err) => return Err(reject_body(err)),
    };
    if parsed.client_turn_id.trim().is_empty()
        || parsed.client_turn_id.chars().count() > TURN_ID_MAX
    {
        return Err(coded(
            StatusCode::BAD_REQUEST,
            "clientTurnId is required",
            "CLIENT_TURN_ID",
        ));
    }
    let name = parsed.name.trim().to_string();
    if !allowed_name(&name) {
        return Err(coded(
            StatusCode::FORBIDDEN,
            "tool not allowed",
            "TOOL_NOT_ALLOWED",
        ));
    }
    if let Some(field) = unexpected_field(&name, &parsed) {
        return Err(rejected_field(field));
    }
    let arguments = arguments_for(&name, &parsed)?;
    let Some(command) = mp_control::tool_call_to_command(&name, &arguments) else {
        return Err(invalid());
    };
    Ok(Prepared {
        name,
        client_turn_id: parsed.client_turn_id,
        command,
    })
}

fn allowed_name(name: &str) -> bool {
    matches!(
        name,
        "pause"
            | "resume"
            | "skip"
            | "stop"
            | "now_playing"
            | "set_volume"
            | "play_music"
            | "queue"
    )
}

fn unexpected_field(name: &str, body: &VerbBody) -> Option<&'static str> {
    let (level, query, source) = match name {
        "set_volume" => (true, false, false),
        "play_music" => (false, true, true),
        "queue" => (false, true, false),
        _ => (false, false, false),
    };
    if body.level.is_some() && !level {
        return Some("level");
    }
    if body.query.is_some() && !query {
        return Some("query");
    }
    if body.source.is_some() && !source {
        return Some("source");
    }
    None
}

fn arguments_for(name: &str, body: &VerbBody) -> Result<Value, Response> {
    match name {
        "pause" | "resume" | "skip" | "stop" | "now_playing" => Ok(json!({})),
        "set_volume" => {
            let level = parse_level(body.level.as_ref())
                .map_err(|()| coded(StatusCode::BAD_REQUEST, "level out of range", "BAD_LEVEL"))?;
            Ok(json!({ "level": level }))
        }
        "play_music" => {
            let query = required_query(body.query.as_ref())?;
            match body.source.as_ref() {
                None => Ok(json!({ "query": query })),
                Some(source) => {
                    let source = parse_source(source)?;
                    Ok(json!({ "query": query, "source": source }))
                }
            }
        }
        "queue" => {
            let query = required_query(body.query.as_ref())?;
            Ok(json!({ "query": query }))
        }
        _ => Err(coded(
            StatusCode::FORBIDDEN,
            "tool not allowed",
            "TOOL_NOT_ALLOWED",
        )),
    }
}

fn parse_level(level: Option<&Value>) -> Result<i64, ()> {
    let Some(Value::Number(number)) = level else {
        return Err(());
    };
    let level = number.as_i64().ok_or(())?;
    if (0..=100).contains(&level) {
        Ok(level)
    } else {
        Err(())
    }
}

fn required_query(query: Option<&Value>) -> Result<String, Response> {
    let Some(Value::String(query)) = query else {
        return Err(coded(
            StatusCode::BAD_REQUEST,
            "query is required",
            "QUERY_REQUIRED",
        ));
    };
    let query = query.trim();
    if query.is_empty() {
        return Err(coded(
            StatusCode::BAD_REQUEST,
            "query is required",
            "QUERY_REQUIRED",
        ));
    }
    if query.chars().count() > QUERY_MAX {
        return Err(coded(
            StatusCode::BAD_REQUEST,
            "query too long",
            "QUERY_TOO_LONG",
        ));
    }
    Ok(query.to_string())
}

fn parse_source(source: &Value) -> Result<&str, Response> {
    let Some(source) = source.as_str() else {
        return Err(bad_source());
    };
    if matches!(source, "local" | "youtube" | "auto") {
        Ok(source)
    } else {
        Err(bad_source())
    }
}

fn bad_source() -> Response {
    coded(StatusCode::BAD_REQUEST, "source not accepted", "BAD_SOURCE")
}

pub(crate) async fn now(State(st): State<AppState>, _user: HandsetUser) -> Response {
    let Some(station) = st.station.as_ref() else {
        return coded(
            StatusCode::SERVICE_UNAVAILABLE,
            "No bot instance available",
            "NO_BOT",
        );
    };
    Json(now_json(station)).into_response()
}

fn now_json(station: &mp_music::MusicStation) -> Value {
    let queue = station.queue.lock().expect("queue");
    let state = station.player.get_state();
    let current = queue.current().map(|song| {
        json!({
            "name": song.name,
            "artist": song.artist,
            "album": song.album,
            "duration": song.duration,
            "platform": song.platform.as_str(),
        })
    });
    json!({
        "connected": station.is_connected(),
        "playing": state == PlayerState::Playing,
        "paused": state == PlayerState::Paused,
        "volume": station.player.get_volume(),
        "elapsed": station.player.get_elapsed(),
        "queueSize": queue.size(),
        "current": current,
    })
}

fn reject_body(err: serde_json::Error) -> Response {
    let msg = err.to_string();
    if let Some(name) = field_name(&msg, "unknown field `") {
        return rejected_field(name);
    }
    if field_name(&msg, "missing field `").as_deref() == Some("clientTurnId") {
        return coded(
            StatusCode::BAD_REQUEST,
            "clientTurnId is required",
            "CLIENT_TURN_ID",
        );
    }
    invalid()
}

fn field_name(msg: &str, prefix: &str) -> Option<String> {
    let rest = msg.strip_prefix(prefix)?;
    let name = rest.split('`').next().unwrap_or("");
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn rejected_field(field: impl Into<String>) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "error": "field not accepted",
            "code": "REJECTED_FIELD",
            "field": field.into(),
        })),
    )
        .into_response()
}

fn invalid() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "invalid request" })),
    )
        .into_response()
}

fn coded(status: StatusCode, error: &str, code: &str) -> Response {
    (status, Json(json!({ "error": error, "code": code }))).into_response()
}

fn stored_response(status: u16, body: Value) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (code, Json(body)).into_response()
}
