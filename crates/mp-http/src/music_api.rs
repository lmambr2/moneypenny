// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use axum::extract::{Multipart, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::authz::{deny_unless, AdminUser, AuthUser};
use crate::json_song::track_json;
use crate::AppState;
use mp_db::{TagSource, TrackTags};

#[derive(Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
    platform: Option<String>,
    limit: Option<u32>,
}

fn clamp(n: Option<u32>, fallback: u32, max: u32) -> u32 {
    n.filter(|x| *x >= 1).unwrap_or(fallback).min(max)
}

pub async fn search(
    State(st): State<AppState>,
    _user: AuthUser,
    Query(q): Query<SearchQuery>,
) -> Response {
    let Some(station) = st.station.as_ref() else {
        return Json(json!({ "songs": [], "playlists": [], "albums": [] })).into_response();
    };
    let query = q.q.unwrap_or_default();
    let plat = q.platform.unwrap_or_else(|| "youtube".into());
    if query.is_empty() && plat != "local" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"q (query) is required","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    if plat != "local" && plat != "youtube" && plat != "stream" {
        return Json(json!({ "songs": [], "playlists": [], "albums": [] })).into_response();
    }
    let lim = if query.is_empty() && plat == "local" {
        clamp(q.limit, 500, 2000)
    } else {
        clamp(q.limit, 20, 50)
    };
    let songs: Vec<Value> = match plat.as_str() {
        "local" => station
            .local
            .search(&query, lim as usize)
            .iter()
            .map(track_json)
            .collect(),
        "youtube" => station
            .youtube
            .search(
                &query,
                lim as usize,
                if mp_music::YoutubeClient::can_handle(&query) {
                    mp_music::YoutubePolicy::Explicit
                } else {
                    mp_music::YoutubePolicy::Search
                },
            )
            .iter()
            .map(track_json)
            .collect(),
        "stream" => mp_music::stream_track(&query)
            .into_iter()
            .map(|t| track_json(&t))
            .collect(),
        _ => Vec::new(),
    };
    Json(json!({ "songs": songs, "playlists": [], "albums": [] })).into_response()
}

pub async fn search_all(
    State(st): State<AppState>,
    _user: AuthUser,
    Query(q): Query<SearchQuery>,
) -> Response {
    let query = q.q.unwrap_or_default();
    if query.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"q (query) is required","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    let lim = clamp(q.limit, 20, 50) as usize;
    let mut songs = st
        .station
        .as_ref()
        .map(|s| {
            s.local
                .search(&query, lim)
                .iter()
                .map(track_json)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if let Some(stn) = st.station.as_ref() {
        if songs.len() < lim {
            let need = lim - songs.len();
            for t in stn.youtube.search(&query, need, mp_music::YoutubePolicy::Search) {
                songs.push(track_json(&t));
            }
        }
    }
    Json(json!({ "songs": songs, "albums": [], "playlists": [] })).into_response()
}

pub async fn library(
    State(st): State<AppState>,
    _user: AuthUser,
    Query(q): Query<SearchQuery>,
) -> Json<Value> {
    let lim = clamp(q.limit, 2000, 2000) as usize;
    let songs = st
        .station
        .as_ref()
        .map(|s| {
            s.local
                .search("", lim)
                .iter()
                .map(track_json)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let count = songs.len();
    Json(json!({ "songs": songs, "count": count }))
}

pub async fn stats(State(st): State<AppState>, _user: AuthUser) -> Json<Value> {
    let n = st.station.as_ref().map(|s| s.local.track_count()).unwrap_or(0);
    Json(json!({ "trackCount": n, "platform": "local" }))
}

pub async fn refresh(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let n = st.station.as_ref().map(|s| s.local.refresh()).unwrap_or(0);
    Json(json!({ "trackCount": n }))
}

pub async fn lyrics(Path(_id): Path<String>, _user: AuthUser) -> Json<Value> {
    Json(json!({ "lyrics": [] }))
}

pub async fn blacklist_get(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let entries = st
        .station
        .as_ref()
        .and_then(|s| s.blacklist.as_ref())
        .map(|bl| {
            bl.list()
                .into_iter()
                .map(|e| {
                    json!({
                        "trackKey": e.track_key,
                        "platform": e.platform,
                        "name": e.name,
                        "artist": e.artist,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let keys: Vec<Value> = entries.iter().filter_map(|e| e.get("trackKey").cloned()).collect();
    Json(json!({ "entries": entries, "keys": keys }))
}

pub async fn blacklist_post(
    State(st): State<AppState>,
    admin: AdminUser,
    Json(body): Json<Value>,
) -> Response {
    if let Err(r) = deny_unless(&st, &admin.0, "ban") {
        return r;
    }
    let Some(station) = st.station.as_ref() else {
        return (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({"error":"Blacklist not available"})),
        )
            .into_response();
    };
    let Some(bl) = station.blacklist.as_ref() else {
        return (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({"error":"Blacklist not available"})),
        )
            .into_response();
    };
    let key = body
        .get("trackKey")
        .or_else(|| body.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if key.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"trackKey (or id) is required","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    if key.contains("..") || key.contains('/') || key.contains('\\') {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"Invalid track key","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    match bl.add(
        key,
        body.get("platform").and_then(|v| v.as_str()),
        body.get("name").and_then(|v| v.as_str()),
        body.get("artist").and_then(|v| v.as_str()),
        body.get("reason").and_then(|v| v.as_str()),
        Some(&admin.0.username),
    ) {
        Ok(e) => Json(json!({"ok": true, "trackKey": e.track_key})).into_response(),
        Err(msg) => (StatusCode::FORBIDDEN, Json(json!({"error": msg, "code":"BAN_PROTECTED"})))
            .into_response(),
    }
}

pub async fn blacklist_delete(
    State(st): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<String>,
) -> Json<Value> {
    if let Some(bl) = st.station.as_ref().and_then(|s| s.blacklist.as_ref()) {
        let _ = bl.remove(&id);
    }
    Json(json!({ "ok": true }))
}

pub async fn tags_get(
    State(st): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
) -> Json<Value> {
    let tags = st.db.tags().get(&id).ok().flatten();
    let rating = st
        .db
        .tags()
        .get_rating(&id)
        .unwrap_or(mp_db::RatingSummary { avg: 0.0, count: 0 });
    Json(json!({ "id": id, "tags": tags, "rating": rating }))
}

fn parse_tag_patch(body: &Value) -> TrackTags {
    TrackTags {
        genre: body.get("genre").and_then(|v| v.as_str()).map(|s| s.trim().to_string()),
        subgenre: body.get("subgenre").and_then(|v| v.as_str()).map(|s| s.trim().to_string()),
        mood: body.get("mood").and_then(|v| v.as_str()).map(|s| s.trim().to_string()),
        musical_key: body
            .get("musicalKey")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string()),
        key_scale: body
            .get("keyScale")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string()),
        bpm: body.get("bpm").and_then(|v| v.as_i64()),
        energy: body.get("energy").and_then(|v| v.as_f64()),
        danceability: body.get("danceability").and_then(|v| v.as_f64()),
        ..Default::default()
    }
}

fn tag_patch_empty(t: &TrackTags) -> bool {
    t.genre.is_none()
        && t.subgenre.is_none()
        && t.mood.is_none()
        && t.musical_key.is_none()
        && t.key_scale.is_none()
        && t.bpm.is_none()
        && t.energy.is_none()
        && t.danceability.is_none()
}

fn require_tag_editor(st: &AppState, user: &AuthUser) -> Result<(), Response> {
    if user.role == mp_db::UserRole::Admin {
        return Ok(());
    }
    deny_unless(st, user, "play")
}

pub async fn tags_patch(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Err(r) = require_tag_editor(&st, &user) {
        return r;
    }
    let patch = parse_tag_patch(&body);
    if !tag_patch_empty(&patch) {
        let _ = st.db.tags().upsert(&id, &patch, TagSource::Manual);
    }
    if let Some(b) = body.get("bumper").and_then(|v| v.as_bool()) {
        let _ = st.db.tags().set_bumper(
            &id,
            b,
            body.get("bumperKind").and_then(|v| v.as_str()),
            body.get("opsScope").and_then(|v| v.as_str()),
        );
    }
    Json(json!({
        "success": true,
        "tags": st.db.tags().get(&id).ok().flatten(),
    }))
    .into_response()
}

pub async fn tags_bulk(
    State(st): State<AppState>,
    user: AuthUser,
    Json(body): Json<Value>,
) -> Response {
    if let Err(r) = require_tag_editor(&st, &user) {
        return r;
    }
    let ids: Vec<String> = body
        .get("ids")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if ids.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"ids must be a non-empty string array","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    if ids.len() > 200 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"ids limited to 200 per request","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    let patch = parse_tag_patch(&body);
    let has_bumper = body.get("bumper").and_then(|v| v.as_bool()).is_some();
    if tag_patch_empty(&patch) && !has_bumper {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"provide at least one tag field or bumper","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    let mut updated = 0u32;
    for id in &ids {
        if !tag_patch_empty(&patch) {
            let _ = st.db.tags().upsert(id, &patch, TagSource::Manual);
        }
        if let Some(b) = body.get("bumper").and_then(|v| v.as_bool()) {
            let _ = st.db.tags().set_bumper(
                id,
                b,
                body.get("bumperKind").and_then(|v| v.as_str()),
                body.get("opsScope").and_then(|v| v.as_str()),
            );
        }
        updated += 1;
    }
    Json(json!({ "success": true, "updated": updated, "ids": ids })).into_response()
}

pub async fn tags_guess(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_tag_editor(&st, &user) {
        return r;
    }
    let Some(station) = st.station.as_ref() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"Track not found in library index","code":"NOT_FOUND"})),
        )
            .into_response();
    };
    let Some(detail) = station.local.song_by_id(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"Track not found in library index","code":"NOT_FOUND"})),
        )
            .into_response();
    };
    let (enabled, _, _) = st.brain.llm_snapshot().await;
    if !enabled {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"LLM tag guess is unavailable (bot not wired)","code":"LLM_UNAVAILABLE"})),
        )
            .into_response();
    }
    let existing = st.db.tags().get(&id).ok().flatten();
    let prompt = tag_guess_prompt(
        &detail.title,
        &detail.artist,
        &detail.album,
        existing.as_ref(),
    );
    let Some(raw) = st
        .brain
        .complete_plain("You output JSON only.", &prompt)
        .await
    else {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": "LLM returned no usable tags (disabled, empty reply, or unparseable). Check Settings → LLM.",
                "code": "LLM_GUESS_FAILED"
            })),
        )
            .into_response();
    };
    let Some(guessed) = parse_tag_guess(&raw) else {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": "LLM returned no usable tags (disabled, empty reply, or unparseable). Check Settings → LLM.",
                "code": "LLM_GUESS_FAILED"
            })),
        )
            .into_response();
    };
    let _ = st.db.tags().upsert(&id, &guessed, TagSource::Api);
    Json(json!({
        "success": true,
        "id": id,
        "guessed": guessed,
        "tags": st.db.tags().get(&id).ok().flatten(),
    }))
    .into_response()
}

fn tag_guess_prompt(name: &str, artist: &str, album: &str, existing: Option<&TrackTags>) -> String {
    let mut lines = vec![
        "You tag music for a radio station library (selection filters).".into(),
        "Guess genre, optional subgenre, and mood from the metadata below.".into(),
        "Use short lowercase tokens.".into(),
        format!("Title: {name}"),
        format!("Artist: {artist}"),
        format!("Album: {album}"),
    ];
    if let Some(ex) = existing {
        if ex.genre.is_some() || ex.subgenre.is_some() || ex.mood.is_some() {
            lines.push(format!(
                "Existing tags: genre={}; subgenre={}; mood={}",
                ex.genre.as_deref().unwrap_or(""),
                ex.subgenre.as_deref().unwrap_or(""),
                ex.mood.as_deref().unwrap_or("")
            ));
        }
    }
    lines.push("Reply with ONLY one JSON object: {\"genre\":\"...\",\"subgenre\":\"...\",\"mood\":\"...\"}".into());
    lines.join("\n")
}

fn parse_tag_guess(raw: &str) -> Option<TrackTags> {
    let text = raw.trim();
    let json_str = if let Some(start) = text.find('{') {
        let end = text.rfind('}')?;
        &text[start..=end]
    } else {
        text
    };
    let v: Value = serde_json::from_str(json_str).ok()?;
    let clean = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(48).collect::<String>())
    };
    let t = TrackTags {
        genre: clean("genre"),
        subgenre: clean("subgenre"),
        mood: clean("mood"),
        ..Default::default()
    };
    if t.genre.is_none() && t.subgenre.is_none() && t.mood.is_none() {
        None
    } else {
        Some(t)
    }
}

#[derive(Deserialize)]
pub struct RatingBody {
    stars: Option<i64>,
}

pub async fn rating_post(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<RatingBody>,
) -> Response {
    let stars = body.stars.unwrap_or(0);
    if !(1..=5).contains(&stars) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"stars must be 1..5","code":"BAD_REQUEST"})),
        )
            .into_response();
    }
    let rater = format!("web:{}", user.id);
    if let Err(e) = st.db.tags().rate(&id, &rater, stars) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": e.to_string(),"code":"BAD_REQUEST"})),
        )
            .into_response();
    }
    Json(json!({
        "success": true,
        "rating": st.db.tags().get_rating(&id).ok(),
    }))
    .into_response()
}

pub async fn rating_delete(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Json<Value> {
    let rater = format!("web:{}", user.id);
    let removed = st.db.tags().unrate(&id, &rater).unwrap_or(false);
    Json(json!({
        "success": true,
        "removed": removed,
        "rating": st.db.tags().get_rating(&id).ok(),
    }))
}

pub async fn analyze_status(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let a = &st.radio.config().analyzer;
    Json(json!({
        "enabled": a.enabled,
        "onIngest": a.on_ingest,
        "available": false,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeBody {
    #[allow(dead_code)]
    force: Option<bool>,
    track_id: Option<String>,
}

pub async fn analyze_post(
    State(st): State<AppState>,
    _admin: AdminUser,
    body: Option<Json<AnalyzeBody>>,
) -> Response {
    let cfg = st.radio.config();
    if !cfg.analyzer.enabled {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "Radio analyzer is disabled — enable it in Settings → Radio/DJ",
                "code": "DISABLED"
            })),
        )
            .into_response();
    }
    let track_id = body
        .as_ref()
        .and_then(|j| j.0.track_id.clone())
        .filter(|s| !s.trim().is_empty());
    if let Some(id) = track_id {
        let Some(station) = st.station.as_ref() else {
            return (
                StatusCode::NOT_IMPLEMENTED,
                Json(json!({"error":"Analyzer requires the local music provider","code":"NOT_IMPLEMENTED"})),
            )
                .into_response();
        };
        if station.local.path_for_id(&id).is_none() {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error":"Track not found in library index","code":"NOT_FOUND"})),
            )
                .into_response();
        }
    }
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "error": "Radio analyzer sidecar is not attached on the Rust bot",
            "code": "UNAVAILABLE"
        })),
    )
        .into_response()
}

pub async fn music_upload(
    State(st): State<AppState>,
    _admin: AdminUser,
    mut multipart: Multipart,
) -> Response {
    let Some(station) = st.station.as_ref() else {
        return (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({"error":"Upload not supported","code":"NOT_IMPLEMENTED"})),
        )
            .into_response();
    };
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    loop {
        match multipart.next_field().await {
            Ok(Some(field)) => {
                let name = field.file_name().unwrap_or("upload.bin").to_string();
                let data = match field.bytes().await {
                    Ok(b) => b.to_vec(),
                    Err(e) => {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(json!({"error": e.to_string(), "code":"VALIDATION_ERROR"})),
                        )
                            .into_response();
                    }
                };
                files.push((name, data));
            }
            Ok(None) => break,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error": e.to_string(), "code":"VALIDATION_ERROR"})),
                )
                    .into_response();
            }
        }
        if files.len() > 5 {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"Too many files (max 5 per upload)","code":"VALIDATION_ERROR"})),
            )
                .into_response();
        }
    }
    if files.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"No files uploaded","code":"VALIDATION_ERROR"})),
        )
            .into_response();
    }
    let mut uploaded = Vec::new();
    let mut failed = Vec::new();
    for (name, data) in files {
        if data.len() > 40 * 1024 * 1024 {
            failed.push(json!({"name": name, "error": "File too large (max 40 MB)"}));
            continue;
        }
        match station.local.upload_song(&name, &data) {
            Ok(song) => uploaded.push(track_json(&song)),
            Err(e) => failed.push(json!({"name": name, "error": e.to_string()})),
        }
    }
    Json(json!({
        "success": !uploaded.is_empty(),
        "uploaded": uploaded,
        "failed": failed,
        "count": uploaded.len(),
    }))
    .into_response()
}
