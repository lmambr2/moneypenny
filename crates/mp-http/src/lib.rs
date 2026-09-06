// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Axum HTTP surface. Domain bundle order matches `domain-bundles.ts`:
//! SYSTEM → MCP (stub) → SESSION → BRAIN (stub) → STATION API (stub) → SPA → WS.
//!
//! Phase 0/1 implements health, OpenAPI snapshot, session/setup, CSRF, rate
//! limits, SPA static, and an authenticated WS upgrade stub.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use axum::extract::State;
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use tokio::net::TcpListener;
use tower_http::set_header::SetResponseHeaderLayer;
use tracing::info;

mod csrf;
mod openapi;
mod rate_limit;
mod session;
mod spa;
mod ws;

pub use csrf::csrf_origin_check;
pub use session::SESSION_COOKIE_NAME;

use mp_config::BotConfig;
use mp_db::Database;
use rate_limit::RateLimiter;

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Database>,
    pub config: Arc<BotConfig>,
    pub started: Instant,
    pub static_dir: Option<PathBuf>,
    login_limit: Arc<RateLimiter>,
    setup_limit: Arc<RateLimiter>,
}

impl AppState {
    pub fn new(db: Arc<Database>, config: Arc<BotConfig>, static_dir: Option<PathBuf>) -> Self {
        Self {
            db,
            config,
            started: Instant::now(),
            static_dir,
            login_limit: Arc::new(RateLimiter::new(5, 5.0 / 60.0)),
            setup_limit: Arc::new(RateLimiter::new(3, 3.0 / 60.0)),
        }
    }
}

#[derive(Serialize)]
struct HealthBody {
    status: &'static str,
    version: &'static str,
    opus: OpusHealth,
    llm: LlmHealth,
}

#[derive(Serialize)]
struct OpusHealth {
    native: bool,
    active: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmHealth {
    route: &'static str,
    degraded: bool,
    last_age_sec: Option<u64>,
}

async fn health() -> Json<HealthBody> {
    let native = mp_audio::native_audio_backend() == "rust-libopus";
    Json(HealthBody {
        status: "ok",
        version: "0.1.0",
        opus: OpusHealth {
            native,
            active: if native { "native" } else { "unavailable" },
        },
        llm: LlmHealth {
            route: "none",
            degraded: false,
            last_age_sec: None,
        },
    })
}

async fn healthz() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn public_url(State(st): State<AppState>) -> Json<serde_json::Value> {
    let raw = st.config.public_url.trim().trim_end_matches('/');
    Json(serde_json::json!({
        "publicUrl": if raw.is_empty() { serde_json::Value::Null } else { raw.into() }
    }))
}

fn security_headers() -> SetResponseHeaderLayer<HeaderValue> {
    SetResponseHeaderLayer::overriding(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    )
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/healthz", get(healthz))
        .route("/api/config/public-url", get(public_url))
        .route("/api/openapi.json", get(openapi::openapi_json))
        .route("/api/docs", get(openapi::docs_html))
        .route("/api/docs/", get(openapi::docs_html))
        .route("/api/session/needs-setup", get(session::needs_setup))
        .route("/api/session/setup", post(session::setup))
        .route("/api/session/login", post(session::login))
        .route("/api/session/logout", post(session::logout))
        .route("/api/session/me", get(session::me))
        .route(
            "/api/session/change-password",
            post(session::change_password),
        )
        .route("/v1/turn", post(brain_stub))
        .layer(axum::middleware::from_fn(csrf::csrf_origin_check));

    let ws_route = Router::new().route("/ws", get(ws::upgrade));

    let mut app = Router::new()
        .merge(api)
        .merge(ws_route)
        .layer(security_headers())
        .layer(SetResponseHeaderLayer::overriding(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static("frame-ancestors 'none'"),
        ));

    app = spa::with_spa(app, state.static_dir.clone());
    app.with_state(state)
}

async fn brain_stub() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({
            "error": "brain not ported yet",
            "toolProposals": [],
            "replyText": "",
            "sources": [],
            "executeTools": false,
        })),
    )
}

pub async fn serve(state: AppState, addr: SocketAddr) -> Result<(), std::io::Error> {
    let app = router(state);
    let listener = TcpListener::bind(addr).await?;
    info!(%addr, "http listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut s) = signal(SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
    info!("shutdown signal");
}

/// Cookie helper used by session handlers.
pub(crate) fn set_session_cookie(
    mut res: axum::http::Response<axum::body::Body>,
    token: &str,
    secure: bool,
) -> axum::http::Response<axum::body::Body> {
    let mut v = format!(
        "{SESSION_COOKIE_NAME}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={}",
        mp_db::SESSION_TTL_MS / 1000
    );
    if secure {
        v.push_str("; Secure");
    }
    if let Ok(hv) = HeaderValue::from_str(&v) {
        res.headers_mut().append(header::SET_COOKIE, hv);
    }
    res
}

pub(crate) fn clear_session_cookie(
    mut res: axum::http::Response<axum::body::Body>,
) -> axum::http::Response<axum::body::Body> {
    let v = format!("{SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    if let Ok(hv) = HeaderValue::from_str(&v) {
        res.headers_mut().append(header::SET_COOKIE, hv);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn test_app() -> Router {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let cfg = Arc::new(BotConfig::default());
        router(AppState::new(db, cfg, None))
    }

    #[tokio::test]
    async fn health_ok() {
        let app = test_app();
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["status"], "ok");
        assert_eq!(v["version"], "0.1.0");
        assert!(v["opus"]["native"].is_boolean());
        assert_eq!(v["llm"]["route"], "none");
    }

    #[tokio::test]
    async fn needs_setup_true_on_empty_users() {
        let app = test_app();
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/session/needs-setup")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["needsSetup"], true);
    }

    #[tokio::test]
    async fn setup_rejected_without_csrf_origin() {
        let app = test_app();
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session/setup")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .body(Body::from(r#"{"username":"admin","password":"password12"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn setup_creates_admin() {
        let app = test_app();
        let res = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/session/setup")
                    .header("content-type", "application/json")
                    .header("host", "localhost:3000")
                    .header("origin", "http://localhost:3000")
                    .body(Body::from(r#"{"username":"admin","password":"password12"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let set_cookie = res.headers().get(header::SET_COOKIE).unwrap().to_str().unwrap();
        assert!(set_cookie.starts_with("moneypenny_session="));
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("SameSite=Lax"));
        let bytes = axum::body::to_bytes(res.into_body(), 64 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["username"], "admin");
        assert_eq!(v["role"], "admin");
    }

    #[tokio::test]
    async fn openapi_lists_frozen_paths() {
        let app = test_app();
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/openapi.json")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v["paths"]["/api/health"]["get"].is_object());
        assert!(v["paths"]["/api/session/needs-setup"]["get"].is_object());
        assert!(v["paths"]["/v1/turn"]["post"].is_object());
    }
}
