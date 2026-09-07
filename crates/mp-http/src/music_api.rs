// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::authz::{deny_unless, AdminUser, AuthUser};
use crate::json_song::track_json;
use crate::AppState;

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

pub async fn tags_get(_user: AuthUser) -> Json<Value> {
    Json(json!({ "tags": {} }))
}

pub async fn analyze_status(_admin: AdminUser) -> Json<Value> {
    Json(json!({ "running": false, "done": 0, "total": 0 }))
}
