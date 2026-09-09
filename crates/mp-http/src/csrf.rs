// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Same-origin CSRF: mutating requests must present Origin/Referer host == Host.
//! Port of `bot/src/web/middleware/csrf.ts`.

use axum::extract::Request;
use axum::http::{header, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;

pub async fn csrf_origin_check(req: Request, next: Next) -> Response {
    if matches!(
        *req.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) {
        return next.run(req).await;
    }
    let expected = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let origin = host_of_header(req.headers().get(header::ORIGIN));
    let referer = host_of_header(req.headers().get(header::REFERER));
    let header_host = origin.or(referer);
    if header_host.as_deref() != Some(expected.as_str()) || expected.is_empty() {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "bad origin" })),
        )
            .into_response();
    }
    next.run(req).await
}

fn host_of_header(value: Option<&axum::http::HeaderValue>) -> Option<String> {
    let raw = value?.to_str().ok()?;
    host_of(raw)
}

pub(crate) fn host_of(url: &str) -> Option<String> {
    // Origin is an absolute URL. Some browsers send the literal "null".
    if url.eq_ignore_ascii_case("null") || url.is_empty() {
        return None;
    }
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let host = rest.split('/').next()?.split('?').next()?.trim();
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_of_origin() {
        assert_eq!(
            host_of("http://localhost:3000"),
            Some("localhost:3000".into())
        );
        assert_eq!(
            host_of("https://music.example.com/path"),
            Some("music.example.com".into())
        );
        assert_eq!(host_of("null"), None);
        assert_eq!(host_of(""), None);
    }
}
