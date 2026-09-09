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
        let user = AuthUser::from_request_parts(parts, state).await?;
        if user.role != UserRole::Admin {
            return Err(forbidden());
        }
        Ok(AdminUser(user))
    }
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
