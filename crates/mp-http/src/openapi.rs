// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Frozen OpenAPI snapshot of Node `API_OPERATIONS` at ec464a2.

use axum::http::header;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

const GOLDEN: &str = include_str!("../fixtures/openapi-operations.json");

#[derive(Deserialize)]
struct Op {
    method: String,
    path: String,
}

fn operations() -> Vec<Op> {
    serde_json::from_str(GOLDEN).unwrap_or_default()
}

pub async fn openapi_json() -> impl IntoResponse {
    Json(build_document())
}

pub async fn docs_html() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        r#"<!doctype html><meta charset="utf-8"><title>Moneypenny API</title>
<p>OpenAPI snapshot: <a href="/api/openapi.json">/api/openapi.json</a></p>
<p>Rust rewrite Phase 0/1 — handlers for health + session only. Remaining paths are catalogued, not implemented.</p>"#,
    )
}

pub fn build_document() -> Value {
    let mut paths = serde_json::Map::new();
    for op in operations() {
        let item = paths
            .entry(op.path.clone())
            .or_insert_with(|| json!({}));
        if let Some(obj) = item.as_object_mut() {
            obj.insert(
                op.method.to_ascii_lowercase(),
                json!({
                    "summary": op.path,
                    "responses": { "200": { "description": "Success (shape varies by endpoint)" } }
                }),
            );
        }
    }
    json!({
        "openapi": "3.0.3",
        "info": {
            "title": "Moneypenny station API",
            "version": "0.1.0",
            "description": "Golden snapshot of Node API_OPERATIONS (ec464a2). Rust implements health + session first."
        },
        "components": {
            "securitySchemes": {
                "cookieAuth": {
                    "type": "apiKey",
                    "in": "cookie",
                    "name": "moneypenny_session"
                }
            }
        },
        "paths": paths
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_has_health_and_turn() {
        let ops = operations();
        assert!(ops.len() >= 100, "got {}", ops.len());
        assert!(ops.iter().any(|o| o.method == "GET" && o.path == "/api/health"));
        assert!(ops.iter().any(|o| o.method == "POST" && o.path == "/v1/turn"));
        assert!(ops
            .iter()
            .any(|o| o.method == "GET" && o.path == "/api/session/needs-setup"));
    }
}
