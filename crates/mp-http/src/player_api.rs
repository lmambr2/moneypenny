// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::authz::{deny_unless, AdminUser, AuthUser};
use crate::bot_api::{bot_status_json, broadcast_state, queue_json};
use crate::json_song::{queued_from_body, queued_json, track_json};
use crate::AppState;
use mp_control::{parse_command, ParsedCommand};
use mp_music::{replace_queue_with_song, PlayMode, QueuedSong, QueueSource};

fn unknown_bot(st: &AppState, id: &str) -> Option<Response> {
    if id != st.bot_id {
        Some(
            (StatusCode::NOT_FOUND, Json(json!({"error":"Bot not found"}))).into_response(),
        )
    } else {
        None
    }
}

fn no_station() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error":"music station not ready"})),
    )
        .into_response()
}

async fn run_named(
    st: &AppState,
    user: &AuthUser,
    name: &str,
    args: &str,
) -> Result<String, Response> {
    deny_unless(st, user, name)?;
    let Some(ex) = st.executor.as_ref() else {
        return Err(no_station());
    };
    let cmd = ParsedCommand {
        name: name.to_string(),
        args: args.to_string(),
        raw_args: if args.is_empty() {
            vec![]
        } else {
            args.split_whitespace().map(str::to_string).collect()
        },
        flags: Default::default(),
    };
    let subject = mp_rights::Subject {
        uid: user.id.clone(),
        server_groups: Vec::new(),
        nickname: Some(user.username.clone()),
    };
    Ok(crate::command::dispatch_command(
        &cmd,
        &subject,
        mp_rights::Scope::Chat,
        ex,
        st.rights.as_deref(),
        &st.db,
        &st.brain,
        st.rag.as_deref(),
        Some(&st.radio),
        Some(&st.roast),
    )
    .await
    .unwrap_or_default())
}

pub async fn play(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(r) = unknown_bot(&st, &id) {
        return r;
    }
    let q = body.get("query").and_then(|v| v.as_str()).unwrap_or("");
    if q.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"query is required","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    match run_named(&st, &user, "play", q).await {
        Ok(message) => {
            record_current(&st);
            broadcast_state(&st);
            Json(json!({ "message": message })).into_response()
        }
        Err(r) => r,
    }
}

pub async fn add(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(r) = unknown_bot(&st, &id) {
        return r;
    }
    let q = body.get("query").and_then(|v| v.as_str()).unwrap_or("");
    match run_named(&st, &user, "add", q).await {
        Ok(message) => {
            broadcast_state(&st);
            Json(json!({ "message": message })).into_response()
        }
        Err(r) => r,
    }
}

async fn simple_cmd(st: AppState, user: AuthUser, id: String, name: &str) -> Response {
    if let Some(r) = unknown_bot(&st, &id) {
        return r;
    }
    match run_named(&st, &user, name, "").await {
        Ok(message) => {
            broadcast_state(&st);
            Json(json!({ "message": message })).into_response()
        }
        Err(r) => r,
    }
}

pub async fn pause(State(st): State<AppState>, user: AuthUser, Path(id): Path<String>) -> Response {
    simple_cmd(st, user, id, "pause").await
}
pub async fn resume(State(st): State<AppState>, user: AuthUser, Path(id): Path<String>) -> Response {
    simple_cmd(st, user, id, "resume").await
}
pub async fn next(State(st): State<AppState>, user: AuthUser, Path(id): Path<String>) -> Response {
    simple_cmd(st, user, id, "skip").await
}
pub async fn prev(State(st): State<AppState>, user: AuthUser, Path(id): Path<String>) -> Response {
    simple_cmd(st, user, id, "prev").await
}
pub async fn stop(
    State(st): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
) -> Response {
    simple_cmd(st, admin.0, id, "stop").await
}

pub async fn elapsed(
    State(st): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    if let Some(r) = unknown_bot(&st, &id) {
        return r;
    }
    let e = st
        .station
        .as_ref()
        .map(|s| s.player.get_elapsed())
        .unwrap_or(0.0);
    Json(json!({ "elapsed": e })).into_response()
}

pub async fn queue_get(
    State(st): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    if let Some(r) = unknown_bot(&st, &id) {
        return r;
    }
    Json(json!({
        "queue": queue_json(&st),
        "status": bot_status_json(&st),
    }))
    .into_response()
}

pub async fn queue_remove(
    State(st): State<AppState>,
    admin: AdminUser,
    Path((id, index)): Path<(String, i32)>,
) -> Response {
    if let Some(r) = unknown_bot(&st, &id) {
        return r;
    }
    match run_named(&st, &admin.0, "remove", &index.to_string()).await {
        Ok(message) => {
            broadcast_state(&st);
            Json(json!({ "message": message })).into_response()
        }
        Err(r) => r,
    }
}

pub async fn volume(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(r) = unknown_bot(&st, &id) {
        return r;
    }
    let vol = body.get("volume").and_then(|v| v.as_i64()).unwrap_or(-1);
    match run_named(&st, &user, "vol", &vol.to_string()).await {
        Ok(message) => {
            broadcast_state(&st);
            Json(json!({ "message": message })).into_response()
        }
        Err(r) => r,
    }
}

pub async fn mode(
    State(st): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(r) = unknown_bot(&st, &id) {
        return r;
    }
    let m = body.get("mode").and_then(|v| v.as_str()).unwrap_or("");
    match run_named(&st, &admin.0, "mode", m).await {
        Ok(message) => {
            broadcast_state(&st);
            Json(json!({ "message": message })).into_response()
        }
        Err(r) => r,
    }
}

pub async fn play_at(
    State(st): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(r) = unknown_bot(&st, &id) {
        return r;
    }
    if let Err(r) = deny_unless(&st, &admin.0, "play") {
        return r;
    }
    let Some(index) = body.get("index").and_then(|v| v.as_u64()).map(|n| n as usize) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"index is required","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    };
    let Some(station) = st.station.as_ref() else {
        return no_station();
    };
    let song = {
        let mut q = station.queue.lock().expect("queue");
        if index >= q.size() {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"Invalid queue index","code":"VALIDATION_ERROR"})),
            )
                .into_response();
        }
        station.player.stop();
        station.player.reset_failures();
        q.play_at(index)
    };
    let Some(song) = song else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"Invalid queue index"})),
        )
            .into_response();
    };
    if !station.resolve_and_play(&song) {
        return Json(json!({ "message": format!("Cannot play: {}", song.name) })).into_response();
    }
    record_song(&st, &song);
    broadcast_state(&st);
    Json(json!({ "message": format!("Now playing: {} - {}", song.name, song.artist) }))
        .into_response()
}

pub async fn play_song(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(r) = unknown_bot(&st, &id) {
        return r;
    }
    if let Err(r) = deny_unless(&st, &user, "play") {
        return r;
    }
    let Some(song_v) = body.get("song") else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"song object with id and platform is required","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    };
    let Some(queued) = queued_from_body(song_v) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"song object with id and platform is required","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    };
    let Some(station) = st.station.as_ref() else {
        return no_station();
    };
    let busy = station.player.get_state() != mp_music::PlayerState::Idle
        || station.queue.lock().expect("queue").size() > 0;
    if busy {
        if let Err(r) = deny_unless(&st, &user, "clear") {
            return r;
        }
    }
    {
        let mut q = station.queue.lock().expect("queue");
        replace_queue_with_song(&mut q, queued.clone());
    }
    station.player.reset_failures();
    if !station.resolve_and_play(&queued) {
        return Json(json!({
            "ok": false,
            "message": format!("Cannot play \"{}\" (source or region restriction)", queued.name)
        }))
        .into_response();
    }
    record_song(&st, &queued);
    broadcast_state(&st);
    Json(json!({
        "ok": true,
        "message": format!("Now playing: {} - {}", queued.name, queued.artist)
    }))
    .into_response()
}

pub async fn add_song(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(r) = unknown_bot(&st, &id) {
        return r;
    }
    if let Err(r) = deny_unless(&st, &user, "add") {
        return r;
    }
    let Some(queued) = body.get("song").and_then(queued_from_body) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"song object with id and platform is required","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    };
    let Some(station) = st.station.as_ref() else {
        return no_station();
    };
    let was_idle = station.player.get_state() == mp_music::PlayerState::Idle;
    let at = {
        let mut q = station.queue.lock().expect("queue");
        q.add(queued.clone())
    };
    if was_idle {
        {
            let mut q = station.queue.lock().expect("queue");
            q.play_at(at);
        }
        station.player.reset_failures();
        let _ = station.resolve_and_play(&queued);
        record_song(&st, &queued);
        broadcast_state(&st);
        return Json(json!({
            "message": format!("Now playing: {} - {}", queued.name, queued.artist)
        }))
        .into_response();
    }
    broadcast_state(&st);
    Json(json!({
        "message": format!("Added to queue: {} - {} (up next)", queued.name, queued.artist)
    }))
    .into_response()
}

pub async fn play_by_id(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(r) = unknown_bot(&st, &id) {
        return r;
    }
    if let Err(r) = deny_unless(&st, &user, "play") {
        return r;
    }
    let song_id = body.get("songId").and_then(|v| v.as_str()).unwrap_or("");
    let Some(station) = st.station.as_ref() else {
        return no_station();
    };
    let Some(track) = station.local.song_by_id(song_id) else {
        return Json(json!({ "message": "Song not found" })).into_response();
    };
    let queued = QueuedSong::from_track(track, QueueSource::User);
    {
        let mut q = station.queue.lock().expect("queue");
        replace_queue_with_song(&mut q, queued.clone());
    }
    station.player.reset_failures();
    if !station.resolve_and_play(&queued) {
        return Json(json!({ "ok": false, "message": format!("Cannot play: {}", queued.name) }))
            .into_response();
    }
    record_song(&st, &queued);
    broadcast_state(&st);
    Json(json!({
        "ok": true,
        "message": format!("Now playing: {} - {}", queued.name, queued.artist)
    }))
    .into_response()
}

pub async fn add_by_id(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(r) = unknown_bot(&st, &id) {
        return r;
    }
    let song_id = body.get("songId").and_then(|v| v.as_str()).unwrap_or("");
    let Some(station) = st.station.as_ref() else {
        return no_station();
    };
    let Some(track) = station.local.song_by_id(song_id) else {
        return Json(json!({ "message": "Song not found" })).into_response();
    };
    add_song(
        State(st),
        user,
        Path(id),
        Json(json!({ "song": track_json(&track) })),
    )
    .await
}

pub async fn play_next_song(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(r) = unknown_bot(&st, &id) {
        return r;
    }
    if let Err(r) = deny_unless(&st, &user, "playnext") {
        return r;
    }
    let Some(queued) = body.get("song").and_then(queued_from_body) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"song object with id and platform is required"})),
        )
            .into_response();
    };
    let Some(station) = st.station.as_ref() else {
        return no_station();
    };
    station.queue.lock().expect("queue").add_next(queued.clone());
    broadcast_state(&st);
    Json(json!({
        "ok": true,
        "message": format!("Added next: {} - {}", queued.name, queued.artist)
    }))
    .into_response()
}

pub async fn seek(
    State(st): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Some(r) = unknown_bot(&st, &id) {
        return r;
    }
    let pos = body.get("position").and_then(|v| v.as_f64()).unwrap_or(0.0);
    Json(json!({ "message": format!("Seeked to {}s", pos.floor() as i64), "seekOffset": pos }))
        .into_response()
}

pub async fn history(
    State(st): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<HistoryQuery>,
) -> Response {
    if let Some(r) = unknown_bot(&st, &id) {
        return r;
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let rows = st.db.play_history().list(&id, limit).unwrap_or_default();
    let history: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "id": r.song_id,
                "name": r.song_name,
                "artist": r.artist,
                "album": r.album,
                "duration": 0,
                "coverUrl": r.cover_url,
                "platform": r.platform,
                "playedAt": r.played_at,
            })
        })
        .collect();
    Json(json!({ "history": history })).into_response()
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    limit: Option<u32>,
}

pub async fn profile_get(_user: AuthUser) -> Json<Value> {
    Json(json!({
        "avatarEnabled": true,
        "descriptionEnabled": true,
        "nicknameEnabled": true,
        "awayEnabled": true,
        "channelDescEnabled": true,
        "nowPlayingEnabled": true,
    }))
}

pub async fn profile_put(_admin: AdminUser, Json(_body): Json<Value>) -> Json<Value> {
    Json(json!({ "ok": true }))
}

fn record_current(st: &AppState) {
    if let Some(station) = st.station.as_ref() {
        if let Some(s) = station.queue.lock().expect("queue").current() {
            record_song(st, &s);
        }
    }
}

fn record_song(st: &AppState, s: &QueuedSong) {
    let _ = st.db.play_history().insert(
        &st.bot_id,
        &s.id,
        &s.name,
        &s.artist,
        &s.album,
        s.platform.as_str(),
        &s.cover_url,
    );
}

#[allow(dead_code)]
fn _touch_parse() {
    let _ = parse_command("!play x", "!", &Default::default());
    let _ = PlayMode::Sequential;
    let _ = queued_json;
}
