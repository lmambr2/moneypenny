// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! WebSocket `/ws`. Cookie + Origin checks. Sends `init` then live `stateChange`.

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::bot_api::bot_status_json;
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
        let origin_host = crate::csrf::host_of(origin).unwrap_or_default();
        if origin_host.is_empty() || origin_host != host {
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
    ws.on_upgrade(move |socket| handle_socket(socket, st))
        .into_response()
}

async fn handle_socket(mut socket: WebSocket, st: AppState) {
    let init = json!({
        "type": "init",
        "bots": [bot_status_json(&st)],
    });
    if socket
        .send(Message::Text(init.to_string().into()))
        .await
        .is_err()
    {
        return;
    }
    let mut rx = st.ws_tx.subscribe();
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            ev = rx.recv() => {
                match ev {
                    Ok(v) => {
                        if socket.send(Message::Text(v.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(_) => break,
                }
            }
        }
    }
}
