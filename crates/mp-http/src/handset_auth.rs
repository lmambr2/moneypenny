// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Device bearer for the handset listener. `Authorization: Bearer mpd_…`.
//! Session cookies, `ECONOMY_INGEST_TOKEN`, and `MCP_TOKEN` are not devices.
//! This extractor is not used by `AdminUser`.

use axum::Json;
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::AppState;
use mp_db::HANDSET_TOKEN_PREFIX;

#[derive(Clone, Debug)]
pub struct HandsetUser {
    pub id: String,
    pub label: String,
}

impl FromRequestParts<AppState> for HandsetUser {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let Some(token) = bearer_token(header) else {
            return Err(unauthenticated());
        };
        if !token.starts_with(HANDSET_TOKEN_PREFIX) {
            return Err(unauthenticated());
        }
        match state.db.handsets().validate_and_touch(token) {
            Ok(Some(device)) => Ok(Self {
                id: device.id,
                label: device.label,
            }),
            Ok(None) => Err(unauthenticated()),
            Err(e) => {
                tracing::warn!(error = %e, "handset token lookup failed");
                Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error":"unavailable"})),
                )
                    .into_response())
            }
        }
    }
}

fn unauthenticated() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error":"unauthenticated"})),
    )
        .into_response()
}

/// `Bearer <token>`. Duplicated from the admin splitter so a device token
/// cannot fall through `AdminUser`.
fn bearer_token(header: &str) -> Option<&str> {
    let (scheme, rest) = header.trim().split_once(|c: char| c.is_whitespace())?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = rest.trim();
    if token.is_empty() { None } else { Some(token) }
}
