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

pub async fn auth_status(_user: AuthUser) -> Json<Value> {
    Json(json!({ "platform": "youtube", "loggedIn": true, "nickname": "Local" }))
}

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

pub async fn economy_ores(_user: AuthUser) -> Json<Value> {
    Json(json!({ "ores": [] }))
}
pub async fn economy_methods(_user: AuthUser) -> Json<Value> {
    Json(json!({ "methods": [] }))
}
pub async fn economy_workorders(_user: AuthUser) -> Json<Value> {
    Json(json!({ "orders": [], "materials": [] }))
}
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
pub async fn economy_commodities(_user: AuthUser) -> Json<Value> {
    Json(json!({ "commodities": [] }))
}
pub async fn economy_ok(_user: AuthUser) -> Json<Value> {
    Json(json!({ "ok": true }))
}

pub async fn rag_doctrine(_admin: AdminUser) -> Json<Value> {
    Json(json!({ "docs": [] }))
}
pub async fn rag_export_caps(_admin: AdminUser) -> Json<Value> {
    Json(json!({ "pandoc": false }))
}
pub async fn rag_hygiene(_admin: AdminUser) -> Json<Value> {
    Json(json!({ "docCount": 0, "expiredCount": 0, "reindex": { "endpoint": "POST /api/rag/doctrine/reindex" } }))
}

pub async fn harness_turns(_user: AuthUser) -> Json<Value> {
    Json(json!({ "turns": [] }))
}
pub async fn harness_ask(_user: AuthUser) -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({
            "error": "brain not ported yet",
            "turn": { "id": "stub", "error": "brain not ported yet (Phase 4)" }
        })),
    )
        .into_response()
}

pub async fn bot_status_stub(_admin: AdminUser) -> Json<Value> {
    Json(json!({
        "ok": false,
        "configured": false,
        "message": "not ported yet",
    }))
}

pub async fn users_list(State(st): State<AppState>, _admin: AdminUser) -> Json<Value> {
    let users = st
        .db
        .users()
        .list_users()
        .unwrap_or_default()
        .into_iter()
        .map(|u| {
            json!({
                "id": u.id,
                "username": u.username,
                "role": u.role.as_str(),
                "createdAt": u.created_at,
            })
        })
        .collect::<Vec<_>>();
    Json(json!({ "users": users }))
}

pub async fn audit_list(_admin: AdminUser) -> Json<Value> {
    Json(json!({ "entries": [] }))
}

pub async fn not_ported(_user: AuthUser) -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({"error":"not ported yet"})),
    )
        .into_response()
}
