// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Empty-but-shaped JSON so Vue pages do not 404. Domain logic is later phases.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::authz::{AdminUser, AuthUser};
use crate::AppState;

pub async fn auth_status(State(st): State<AppState>, _user: AuthUser) -> Json<Value> {
    let yt = st
        .station
        .as_ref()
        .is_some_and(|s| s.youtube.available());
    Json(json!({
        "platform": "youtube",
        "loggedIn": yt,
        "nickname": if yt { "YouTube (yt-dlp)" } else { "YouTube (yt-dlp not installed)" },
    }))
}

pub async fn bot_status_stub(_admin: AdminUser) -> Json<Value> {
    Json(json!({
        "ok": false,
        "configured": false,
        "message": "not ported yet",
    }))
}

pub async fn not_ported(_user: AuthUser) -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({"error":"not ported yet"})),
    )
        .into_response()
}
