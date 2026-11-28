// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Typed handset turn. The phone sends text. The bot runs at most two of the
//! eight music tools. Push-to-talk is a different route. The flight lock is
//! one per process. A finished `clientTurnId` is remembered for five minutes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

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

const TTL_MS: u64 = 5 * 60 * 1000;
const CAP: usize = 32;
const TEXT_MAX: usize = 4000;
const TURN_ID_MAX: usize = 64;

const HANDSET_TOOL_NAMES: &[&str] = &[
    "play_music",
    "pause",
    "skip",
    "resume",
    "set_volume",
    "stop",
    "now_playing",
    "queue",
];

struct StoredHandset {
    at_ms: u64,
    status: u16,
    body: Value,
}

pub(crate) struct HandsetTurnMap {
    inner: Mutex<HashMap<(String, String), StoredHandset>>,
}

pub(crate) type HandsetTurns = Arc<HandsetTurnMap>;

impl HandsetTurnMap {
    pub(crate) fn new() -> HandsetTurns {
        Arc::new(Self {
            inner: Mutex::new(HashMap::new()),
        })
    }

    pub(crate) fn lookup(&self, device: &str, turn: &str) -> Option<(u16, Value)> {
        let map = self.lock();
        let row = map.get(&(device.to_string(), turn.to_string()))?;
        if now_ms().saturating_sub(row.at_ms) >= TTL_MS {
            return None;
        }
        Some((row.status, row.body.clone()))
    }

    pub(crate) fn insert(&self, device: &str, turn: &str, status: u16, body: Value) {
        self.insert_at(device, turn, status, body, now_ms());
    }

    pub(crate) fn insert_at(&self, device: &str, turn: &str, status: u16, body: Value, at_ms: u64) {
        let mut map = self.lock();
        map.insert(
            (device.to_string(), turn.to_string()),
            StoredHandset {
                at_ms,
                status,
                body,
            },
        );
        evict_device(&mut map, device);
    }

    pub(crate) fn len(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(String, String), StoredHandset>> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

fn evict_device(map: &mut HashMap<(String, String), StoredHandset>, device: &str) {
    let mut rows: Vec<(String, u64)> = map
        .iter()
        .filter(|((dev, _), _)| dev == device)
        .map(|((_, id), row)| (id.clone(), row.at_ms))
        .collect();
    if rows.len() <= CAP {
        return;
    }
    rows.sort_by_key(|(_, at)| *at);
    let drop_n = rows.len() - CAP;
    for (id, _) in rows.into_iter().take(drop_n) {
        map.remove(&(device.to_string(), id));
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn handset_tools() -> Vec<Value> {
    mp_brain::music_control_tools()
        .into_iter()
        .filter(|tool| {
            tool["function"]["name"]
                .as_str()
                .is_some_and(|name| HANDSET_TOOL_NAMES.contains(&name))
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TurnBody {
    text: String,
    spoken: bool,
    #[serde(rename = "clientTurnId")]
    client_turn_id: String,
}

pub(crate) async fn turn(
    State(st): State<AppState>,
    user: HandsetUser,
    body: axum::body::Bytes,
) -> Response {
    let span = tracing::info_span!("handset.turn", device_id = %user.id);
    async move { handle(st, user, body).await }
        .instrument(span)
        .await
}

async fn handle(st: AppState, user: HandsetUser, body: axum::body::Bytes) -> Response {
    let parsed: TurnBody = match serde_json::from_slice(&body) {
        Ok(parsed) => parsed,
        Err(err) => return reject_body(err),
    };
    if parsed.spoken {
        return coded(
            StatusCode::BAD_REQUEST,
            "push-to-talk uses POST /v1/handset/utterance",
            "USE_UTTERANCE",
        );
    }
    let text = parsed.text.trim();
    if text.is_empty() {
        return coded(StatusCode::BAD_REQUEST, "text is required", "TEXT_REQUIRED");
    }
    if text.chars().count() > TEXT_MAX {
        return coded(StatusCode::BAD_REQUEST, "text too long", "TEXT_TOO_LONG");
    }
    let client_turn_id = parsed.client_turn_id;
    if client_turn_id.trim().is_empty() || client_turn_id.chars().count() > TURN_ID_MAX {
        return coded(
            StatusCode::BAD_REQUEST,
            "clientTurnId is required",
            "CLIENT_TURN_ID",
        );
    }
    let text = text.to_string();

    if !st.brain.transport_is_in_process().await {
        return coded(
            StatusCode::SERVICE_UNAVAILABLE,
            "brain is remote",
            "BRAIN_REMOTE",
        );
    }

    let tools = handset_tools();
    let prompt = mp_brain::handset_intent_prompt(&st.read_config().llm_system_prompt);
    let Ok(guard) = Arc::clone(&st.handset_flight).try_lock_owned() else {
        return coded(StatusCode::CONFLICT, "handset busy", "BUSY");
    };
    if let Some((status, stored)) = st.handset_turns.lookup(&user.id, &client_turn_id) {
        drop(guard);
        return stored_response(status, stored);
    }

    let turn_req = mp_brain::TurnRequest {
        client_turn_id: Some(client_turn_id.clone()),
        channel: mp_brain::TurnChannel::Dashboard,
        text: text.clone(),
        conversation_id: Some(format!("handset:{}", user.id)),
        subject: None,
        mode: Some(mp_brain::TurnMode::Intent),
        options: Some(mp_brain::TurnOptions {
            include_sources: Some(false),
            max_tools: Some(2),
        }),
        skill: None,
    };
    let brain_res = {
        let work = st.brain.complete_with_tools(turn_req, &tools, &prompt);
        match tokio::time::timeout(st.handset_deadline, work).await {
            Ok(res) => res,
            Err(_) => {
                drop(guard);
                tracing::info!("handset_deadline");
                return (
                    StatusCode::GATEWAY_TIMEOUT,
                    Json(json!({
                        "error": "handset deadline",
                        "code": "DEADLINE",
                        "disposed": false,
                    })),
                )
                    .into_response();
            }
        }
    };
    if let Some(err) = brain_res.error.clone() {
        drop(guard);
        if err == "LLM is not enabled" {
            return coded(StatusCode::CONFLICT, "LLM is not enabled", "LLM_DISABLED");
        }
        if err == "BRAIN_REMOTE" {
            return coded(
                StatusCode::SERVICE_UNAVAILABLE,
                "brain is remote",
                "BRAIN_REMOTE",
            );
        }
        tracing::warn!(error = %err, "handset intent failed");
        return coded(StatusCode::BAD_GATEWAY, "intent failed", "INTENT_FAILED");
    }
    if !brain_res.tool_proposals.is_empty() && st.executor.is_none() {
        drop(guard);
        return coded(StatusCode::CONFLICT, "No bot instance available", "NO_BOT");
    }

    let (tx, rx) = oneshot::channel();
    let task_span = tracing::Span::current();
    let device_id = user.id.clone();
    let text_len = text.chars().count();
    let turn_id = brain_res.turn_id;
    let reply_text = brain_res.reply_text;
    let proposals = brain_res.tool_proposals;
    let client_turn_id_task = client_turn_id.clone();
    let st_task = st.clone();
    tokio::spawn(
        async move {
            finish_turn(
                st_task,
                guard,
                device_id,
                client_turn_id_task,
                turn_id,
                reply_text,
                proposals,
                text_len,
                tx,
            )
            .await;
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

async fn finish_turn(
    st: AppState,
    guard: OwnedMutexGuard<()>,
    device_id: String,
    client_turn_id: String,
    turn_id: String,
    reply_text: String,
    proposals: Vec<mp_brain::ToolProposal>,
    text_len: usize,
    tx: oneshot::Sender<(u16, Value)>,
) {
    if !st.handset_dispose_delay.is_zero() {
        tokio::time::sleep(st.handset_dispose_delay).await;
    }
    let (wire, disposed_ok, ran) = dispose_proposals(&st, &proposals).await;
    if ran {
        crate::bot_api::broadcast_state(&st);
    }
    let body = json!({
        "turnId": turn_id,
        "clientTurnId": client_turn_id,
        "replyText": reply_text,
        "disposedTools": wire,
        "error": null,
    });
    st.handset_turns
        .insert(&device_id, &client_turn_id, 200, body.clone());
    drop(guard);
    let _ = tx.send((200, body));
    tracing::info!(
        spoken = false,
        text_len,
        tool_count = proposals.len(),
        disposed_ok,
        status = 200u16,
        "handset turn finished",
    );
}

pub(crate) async fn dispose_proposals(
    st: &AppState,
    proposals: &[mp_brain::ToolProposal],
) -> (Vec<Value>, usize, bool) {
    let Some(executor) = st.executor.clone() else {
        return (Vec::new(), 0, false);
    };
    let disposer = mp_control::BrainDisposer::new(executor, st.rights.clone());
    let allow: Vec<String> = HANDSET_TOOL_NAMES
        .iter()
        .map(|name| (*name).to_string())
        .collect();
    let subject = mp_control::Subject {
        uid: None,
        nickname: Some("handset".into()),
        server_groups: Vec::new(),
    };
    let mut wire = Vec::with_capacity(proposals.len());
    let mut disposed_ok = 0usize;
    let mut ran = false;
    for proposal in proposals {
        let rec = disposer
            .dispose_tool_allow(
                &proposal.name,
                &proposal.arguments,
                &subject,
                false,
                false,
                Some(&allow),
            )
            .await;
        let (item, did_run, ok) = rewrite_record(rec);
        if did_run {
            ran = true;
        }
        if ok {
            disposed_ok += 1;
        }
        wire.push(item);
    }
    (wire, disposed_ok, ran)
}

fn rewrite_record(rec: mp_control::ToolDisposeRecord) -> (Value, bool, bool) {
    let name = rec.name;
    let mut ok = rec.ok;
    let mut result = rec.result;
    let mut error = rec.error;
    let policy = error.as_deref().is_some_and(|err| {
        err.contains("allowDangerous")
            || err.starts_with("tool blocked")
            || err.starts_with("tool not allowed")
    });
    let mut ran = false;
    if policy {
        tracing::warn!(tool = %name, "handset tool blocked");
        ok = false;
        result = None;
        error = Some("tool not allowed".into());
    } else if result
        .as_deref()
        .is_some_and(|text| text.starts_with("Usage:"))
    {
        ok = false;
        result = None;
        error = Some("bad tool arguments".into());
        ran = true;
    } else if ok {
        ran = true;
    }
    let item = json!({
        "name": name,
        "ok": ok,
        "result": result,
        "error": error,
    });
    (item, ran, ok)
}

fn reject_body(err: serde_json::Error) -> Response {
    let msg = err.to_string();
    if let Some(name) = field_name(&msg, "unknown field `") {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "field not accepted",
                "code": "REJECTED_FIELD",
                "field": name,
            })),
        )
            .into_response();
    }
    if let Some(name) = field_name(&msg, "missing field `") {
        let (error, code) = match name.as_str() {
            "spoken" => ("spoken must be false", "SPOKEN_REQUIRED"),
            "clientTurnId" => ("clientTurnId is required", "CLIENT_TURN_ID"),
            "text" => ("text is required", "TEXT_REQUIRED"),
            _ => return invalid(),
        };
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": error, "code": code })),
        )
            .into_response();
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn handset_turn_map_keeps_thirty_two_and_other_devices() {
        let map = HandsetTurnMap::new();
        map.insert("other", "keep", 200, json!({ "ok": true }));
        let base = now_ms();
        for i in 0..33 {
            map.insert_at("pixel", &format!("t{i}"), 200, json!(i), base + i);
        }
        assert!(map.lookup("pixel", "t0").is_none());
        assert_eq!(map.lookup("pixel", "t1").unwrap().1, json!(1));
        assert_eq!(map.lookup("pixel", "t32").unwrap().1, json!(32));
        assert!(map.lookup("other", "keep").is_some());
        assert_eq!(map.len(), 33);
    }

    #[test]
    fn handset_turn_map_expires_at_five_minutes() {
        let map = HandsetTurnMap::new();
        map.insert_at("pixel", "old", 200, json!(1), 0);
        assert!(map.lookup("pixel", "old").is_none());
        assert_eq!(map.len(), 1);
        let now = now_ms();
        map.insert_at(
            "pixel",
            "fresh",
            200,
            json!(2),
            now.saturating_sub(TTL_MS - 1_000),
        );
        assert!(map.lookup("pixel", "fresh").is_some());
        map.insert_at("pixel", "edge", 200, json!(3), now.saturating_sub(TTL_MS));
        assert!(map.lookup("pixel", "edge").is_none());
    }
}
