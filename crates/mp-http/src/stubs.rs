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

#[allow(dead_code)]
pub async fn economy_overview(_user: AuthUser) -> Json<Value> {
    Json(json!({
        "catalogAsOf": "",
        "disclaimer": "Economy catalog not ported (Phase 8).",
        "sources": [],
        "clients": { "scCraft": false, "scTrade": false, "scTradeToken": false, "uex": false },
        "cache": { "rootLabel": "", "backend": "none", "totalFiles": 0, "totalBytes": 0, "sources": {} },
        "workOrders": { "available": false, "open": 0, "maxOpen": 100 },
        "oreCount": 0,
        "methodCount": 0,
    }))
}

#[allow(dead_code)]
pub async fn economy_ores(_user: AuthUser) -> Json<Value> {
    Json(json!({ "ores": [] }))
}
#[allow(dead_code)]
pub async fn economy_methods(_user: AuthUser) -> Json<Value> {
    Json(json!({ "methods": [] }))
}
#[allow(dead_code)]
pub async fn economy_workorders(_user: AuthUser) -> Json<Value> {
    Json(json!({ "orders": [], "materials": [] }))
}
#[allow(dead_code)]
pub async fn economy_cache(_user: AuthUser) -> Json<Value> {
    Json(json!({
        "rootLabel": "",
        "backend": "none",
        "totalFiles": 0,
        "totalBytes": 0,
        "sources": {},
        "lastRefresh": null,
    }))
}
#[allow(dead_code)]
pub async fn economy_commodities(_user: AuthUser) -> Json<Value> {
    Json(json!({ "commodities": [] }))
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
