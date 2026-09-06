// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Session cookie API — `/api/session/*`. First-account-is-admin.

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use tokio::time::{sleep, Duration};

use crate::{clear_session_cookie, set_session_cookie, AppState};

pub use mp_config::SESSION_COOKIE_NAME;

const FAILED_LOGIN_DELAY_MS: u64 = 250;

#[derive(Deserialize)]
pub struct SetupBody {
    username: String,
    password: String,
}

#[derive(Deserialize)]
pub struct LoginBody {
    username: String,
    password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordBody {
    #[serde(alias = "oldPassword")]
    old_password: Option<String>,
    #[serde(alias = "currentPassword")]
    current_password: Option<String>,
    new_password: String,
}

pub async fn needs_setup(State(st): State<AppState>) -> impl IntoResponse {
    match st.db.user_count() {
        Ok(n) => Json(json!({ "needsSetup": n == 0 })).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "needs-setup");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":"internal error"})))
                .into_response()
        }
    }
}

pub async fn setup(State(st): State<AppState>, req: Request<Body>) -> Response {
    if let Err(wait) = st.setup_limit.take(&client_ip(&req, &st)) {
        return too_many(wait);
    }
    let secure = is_secure(&req);
    let body = match read_json::<SetupBody>(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    if !valid_username(&body.username) || !valid_password(&body.password) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid username or password"})))
            .into_response();
    }
    match st.db.user_count() {
        Ok(0) => {}
        Ok(_) => {
            return (StatusCode::CONFLICT, Json(json!({"error":"already initialized"})))
                .into_response();
        }
        Err(e) => {
            tracing::error!(error = %e, "setup count");
            return internal();
        }
    }
    match st.db.users().create_first_user(&body.username, &body.password) {
        Ok(Some(user)) => match st.db.sessions().create_session(&user.id) {
            Ok((token, _)) => {
                let body = json!({
                    "id": user.id,
                    "username": user.username,
                    "role": user.role.as_str(),
                });
                let res = (StatusCode::OK, Json(body)).into_response();
                set_session_cookie(res, &token, secure)
            }
            Err(e) => {
                tracing::error!(error = %e, "setup session");
                internal()
            }
        },
        Ok(None) => (StatusCode::CONFLICT, Json(json!({"error":"already initialized"})))
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "setup");
            internal()
        }
    }
}

pub async fn login(State(st): State<AppState>, req: Request<Body>) -> Response {
    if let Err(wait) = st.login_limit.take(&client_ip(&req, &st)) {
        return too_many(wait);
    }
    let secure = is_secure(&req);
    let body = match read_json::<LoginBody>(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    if body.username.is_empty() || body.password.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid request"}))).into_response();
    }
    let user = match st.db.users().find_by_username(&body.username) {
        Ok(u) => u,
        Err(e) => {
            tracing::error!(error = %e, "login lookup");
            return internal();
        }
    };
    let ok = match &user {
        Some(u) => st
            .db
            .users()
            .verify_password(&body.password, &u.password_hash)
            .unwrap_or(false),
        None => false,
    };
    if !ok {
        sleep(Duration::from_millis(FAILED_LOGIN_DELAY_MS)).await;
        return (StatusCode::UNAUTHORIZED, Json(json!({"error":"invalid credentials"})))
            .into_response();
    }
    let user = user.unwrap();
    match st.db.sessions().create_session(&user.id) {
        Ok((token, _)) => {
            let body = json!({
                "id": user.id,
                "username": user.username,
                "role": user.role.as_str(),
            });
            let res = (StatusCode::OK, Json(body)).into_response();
            set_session_cookie(res, &token, secure)
        }
        Err(e) => {
            tracing::error!(error = %e, "login session");
            internal()
        }
    }
}

pub async fn logout(State(st): State<AppState>, req: Request<Body>) -> Response {
    if let Some(token) = extract_session_token(req.headers().get(header::COOKIE)) {
        let _ = st.db.sessions().delete_session(&token);
    }
    let res = StatusCode::NO_CONTENT.into_response();
    clear_session_cookie(res)
}

pub async fn me(State(st): State<AppState>, req: Request<Body>) -> Response {
    match current_user(&st, req.headers().get(header::COOKIE)) {
        Some(u) => Json(json!({
            "id": u.user_id,
            "username": u.username,
            "role": u.role.as_str(),
        }))
        .into_response(),
        None => {
            let res = (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error":"unauthenticated"})),
            )
                .into_response();
            clear_session_cookie(res)
        }
    }
}

pub async fn change_password(State(st): State<AppState>, req: Request<Body>) -> Response {
    let cookie = req.headers().get(header::COOKIE).cloned();
    let Some(sess) = current_user(&st, cookie.as_ref()) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"unauthenticated"})),
        )
            .into_response();
    };
    let body = match read_json::<ChangePasswordBody>(req).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let old = body
        .old_password
        .or(body.current_password)
        .unwrap_or_default();
    let Some(u) = st.db.users().find_by_id(&sess.user_id).ok().flatten() else {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error":"invalid credentials"})))
            .into_response();
    };
    let ok = st
        .db
        .users()
        .verify_password(&old, &u.password_hash)
        .unwrap_or(false);
    if !ok {
        sleep(Duration::from_millis(FAILED_LOGIN_DELAY_MS)).await;
        return (StatusCode::UNAUTHORIZED, Json(json!({"error":"invalid credentials"})))
            .into_response();
    }
    if !valid_password(&body.new_password) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":"invalid request"}))).into_response();
    }
    if let Err(e) = st.db.users().change_password(&u.id, &body.new_password) {
        tracing::error!(error = %e, "change-password");
        return internal();
    }
    let current = extract_session_token(cookie.as_ref());
    let _ = st
        .db
        .sessions()
        .delete_all_for_user(&u.id, current.as_deref());
    StatusCode::NO_CONTENT.into_response()
}

pub fn current_user(
    st: &AppState,
    cookie: Option<&axum::http::HeaderValue>,
) -> Option<mp_db::SessionValidation> {
    let token = extract_session_token(cookie)?;
    st.db.sessions().validate_and_touch(&token).ok().flatten()
}

pub fn extract_session_token(header: Option<&axum::http::HeaderValue>) -> Option<String> {
    let raw = header?.to_str().ok()?;
    for part in raw.split(';') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix(&format!("{SESSION_COOKIE_NAME}=")) {
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn valid_username(s: &str) -> bool {
    let n = s.len();
    (3..=32).contains(&n)
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn valid_password(s: &str) -> bool {
    (8..=200).contains(&s.len())
}

fn is_secure(req: &Request<Body>) -> bool {
    req.headers()
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("https"))
}

fn client_ip(req: &Request<Body>, st: &AppState) -> String {
    if st.config.trust_proxy {
        if let Some(xff) = req
            .headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
        {
            let hops = st.config.trust_proxy_hops.max(1) as usize;
            let parts: Vec<&str> = xff.split(',').map(|s| s.trim()).collect();
            if !parts.is_empty() {
                let idx = parts.len().saturating_sub(hops);
                return parts[idx].to_string();
            }
        }
    }
    req.headers()
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_string()
}

async fn read_json<T: serde::de::DeserializeOwned>(req: Request<Body>) -> Result<T, Response> {
    let bytes = axum::body::to_bytes(req.into_body(), 100 * 1024)
        .await
        .map_err(|_| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid request"})),
            )
                .into_response()
        })?;
    serde_json::from_slice(&bytes).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"invalid request"})),
        )
            .into_response()
    })
}

fn too_many(wait: u64) -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        [(header::RETRY_AFTER, wait.to_string())],
        Json(json!({"error":"rate limited"})),
    )
        .into_response()
}

fn internal() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error":"internal error","code":"INTERNAL_ERROR"})),
    )
        .into_response()
}
