// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Serve `bot/web/dist` with SPA fallback. `/api` and `/ws` never fall through.

use std::path::PathBuf;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;

use crate::AppState;

pub fn with_spa(app: Router<AppState>, _static_dir: Option<PathBuf>) -> Router<AppState> {
    app.fallback(spa_fallback)
}

async fn spa_fallback(State(st): State<AppState>, req: Request<Body>) -> Response {
    let path = req.uri().path();
    if path.starts_with("/api") || path == "/ws" || path.starts_with("/ws/") {
        return not_found();
    }
    let Some(dir) = st.static_dir.as_ref() else {
        return not_found();
    };
    let rel = path.trim_start_matches('/');
    let candidate = if rel.is_empty() {
        dir.join("index.html")
    } else {
        // reject path escape
        if rel.contains("..") {
            return not_found();
        }
        dir.join(rel)
    };
    let file = if candidate.is_file() {
        candidate
    } else {
        dir.join("index.html")
    };
    match std::fs::read(&file) {
        Ok(bytes) => {
            let mime = mime_for(&file);
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "no-cache")],
                bytes,
            )
                .into_response()
        }
        Err(_) => not_found(),
    }
}

fn mime_for(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("json") => "application/json",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "application/json")],
        r#"{"error":"not found"}"#,
    )
        .into_response()
}
