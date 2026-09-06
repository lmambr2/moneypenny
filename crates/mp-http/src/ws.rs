// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! WebSocket upgrade on `/ws`. Same cookie + Origin checks as Node.
//! Phase 0/1: accept the socket and send a hello. Live-status events are Phase 3.

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::session::current_user;
use crate::AppState;

pub async fn upgrade(
    ws: WebSocketUpgrade,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        let origin_host = origin
            .strip_prefix("https://")
            .or_else(|| origin.strip_prefix("http://"))
            .and_then(|r| r.split('/').next())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !origin_host.is_empty() && origin_host != host {
            return (StatusCode::FORBIDDEN, Json(json!({"error":"bad origin"}))).into_response();
        }
    }
    if current_user(&st, headers.get(header::COOKIE)).is_none() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthenticated"})),
        )
            .into_response();
    }
    ws.on_upgrade(handle_socket).into_response()
}

async fn handle_socket(mut socket: WebSocket) {
    let hello = json!({
        "type": "hello",
        "runtime": "rust",
        "note": "live-status events: Phase 3"
    });
    let _ = socket
        .send(Message::Text(hello.to_string().into()))
        .await;
    while let Some(Ok(msg)) = socket.recv().await {
        if matches!(msg, Message::Close(_)) {
            break;
        }
    }
}
