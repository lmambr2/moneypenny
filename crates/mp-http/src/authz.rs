// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Cookie auth extractors. Node: `app.use("/api", requireAuth)` on the
//! protected bundle; admin routes use `requireAdmin` (role === admin).

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::session::current_user;
use crate::AppState;
use mp_db::UserRole;

#[derive(Clone, Debug)]
pub struct AuthUser {
    pub id: String,
    pub username: String,
    pub role: UserRole,
}

#[derive(Clone, Debug)]
pub struct AdminUser(pub AuthUser);

fn unauth() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({"error":"unauthenticated"}))).into_response()
}

fn forbidden() -> Response {
    (StatusCode::FORBIDDEN, Json(json!({"error":"forbidden"}))).into_response()
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let cookie = parts.headers.get(header::COOKIE);
        current_user(state, cookie)
            .map(|s| AuthUser {
                id: s.user_id,
                username: s.username,
                role: s.role,
            })
            .ok_or_else(unauth)
    }
}

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        if let Some(user) = economy_ingest_bearer(parts) {
            return Ok(AdminUser(user));
        }
        let user = AuthUser::from_request_parts(parts, state).await?;
        if user.role != UserRole::Admin {
            return Err(forbidden());
        }
        Ok(AdminUser(user))
    }
}

pub fn bearer_only(headers: &axum::http::HeaderMap) -> bool {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if extract_bearer(auth).is_none() {
        return false;
    }
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    !cookie
        .split(';')
        .any(|part| part.trim_start().starts_with(&format!("{}=", crate::SESSION_COOKIE_NAME)))
}

fn economy_ingest_bearer(parts: &Parts) -> Option<AuthUser> {
    if !parts.uri.path().contains("/economy/ingest") {
        return None;
    }
    let expected = ingest_token()?;
    let header = parts.headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let token = extract_bearer(header)?;
    if !safe_eq(token.as_bytes(), expected.as_bytes()) {
        return None;
    }
    Some(AuthUser {
        id: "ingest:datarunner".into(),
        username: "datarunner".into(),
        role: UserRole::Admin,
    })
}

fn ingest_token() -> Option<String> {
    for key in ["ECONOMY_INGEST_TOKEN", "MCP_TOKEN"] {
        if let Ok(v) = std::env::var(key) {
            let t = v.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

fn extract_bearer(header: &str) -> Option<&str> {
    let trimmed = header.trim();
    let (scheme, rest) = trimmed.split_once(|c: char| c.is_whitespace())?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = rest.trim();
    if token.is_empty() { None } else { Some(token) }
}

fn safe_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        let _ = a.iter().fold(0u8, |acc, byte| acc ^ byte);
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn may_run(st: &AppState, user: &AuthUser, command: &str) -> bool {
    if user.role == UserRole::Admin {
        return true;
    }
    if !st.config.rights_enabled {
        return true;
    }
    let Some(engine) = st.rights.as_ref() else {
        return false;
    };
    let subject = mp_rights::Subject {
        uid: format!("web:{}", user.id),
        server_groups: Vec::new(),
        nickname: Some(user.username.clone()),
    };
    engine.can(&subject, command, mp_rights::Scope::Chat)
}

pub fn deny_unless(st: &AppState, user: &AuthUser, command: &str) -> Result<(), Response> {
    if may_run(st, user, command) {
        return Ok(());
    }
    Err((
        StatusCode::FORBIDDEN,
        Json(json!({
            "error": format!("You don't have permission to use '{command}'."),
            "code": "PERMISSION_DENIED"
        })),
    )
        .into_response())
}
