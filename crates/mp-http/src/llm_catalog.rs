// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Live model list for Settings. OpenAI `/v1/models`, Strata's `meta.n_ctx`
//! shape, and Ollama `/api/tags`.

use std::time::Duration;

use axum::Json;
use axum::extract::{Query, State};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{Value, json};

use crate::AppState;
use crate::authz::AdminUser;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CatalogModel {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    owned_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_model_len: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<String>,
}

#[derive(Debug, Serialize)]
struct Catalog {
    url: String,
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    models: Vec<CatalogModel>,
}

#[derive(Deserialize)]
pub struct ModelsQuery {
    url: Option<String>,
    role: Option<String>,
}

pub async fn llm_models(
    State(st): State<AppState>,
    _admin: AdminUser,
    Query(q): Query<ModelsQuery>,
) -> Json<Value> {
    let url_q = q.url.unwrap_or_default();
    let url_q = url_q.trim();
    if !url_q.is_empty() {
        return Json(json!({ "catalog": catalog_value(&st, url_q).await }));
    }
    let (_, primary_url, primary_model) = st.brain.llm_snapshot().await;
    let (fallback_url, delegate_url, fallback_model, delegate_model) = {
        let cfg = st.read_config();
        (
            cfg.llm_fallback_url.clone(),
            cfg.llm_delegate_url.clone(),
            cfg.llm_fallback_model.clone(),
            cfg.llm_delegate_model.clone(),
        )
    };
    let role = q.role.unwrap_or_default();
    let role = role.trim();
    if matches!(role, "primary" | "fallback" | "delegate") {
        let pick = match role {
            "fallback" => fallback_url,
            "delegate" => delegate_url,
            _ => primary_url,
        };
        let catalog = if pick.trim().is_empty() {
            empty_catalog("")
        } else {
            catalog_value(&st, pick.trim()).await
        };
        return Json(json!({ "role": role, "catalog": catalog }));
    }
    let primary = if primary_url.trim().is_empty() {
        empty_catalog("")
    } else {
        catalog_value(&st, primary_url.trim()).await
    };
    let fallback = if fallback_url.trim().is_empty() {
        Value::Null
    } else {
        catalog_value(&st, fallback_url.trim()).await
    };
    let delegate = if delegate_url.trim().is_empty() {
        Value::Null
    } else {
        catalog_value(&st, delegate_url.trim()).await
    };
    Json(json!({
        "selected": {
            "primary": primary_model,
            "fallback": fallback_model,
            "delegate": delegate_model,
        },
        "primary": primary,
        "fallback": fallback,
        "delegate": delegate,
    }))
}

async fn catalog_value(st: &AppState, raw: &str) -> Value {
    serde_json::to_value(fetch_llm_catalog(raw, bearer_if_delegate(st, raw)).await).unwrap_or_else(
        |_| json!({ "url": raw, "available": false, "error": "unreachable", "models": [] }),
    )
}

fn bearer_if_delegate(st: &AppState, raw: &str) -> Option<String> {
    let origin = parse_llm_origin(raw)?;
    let delegate = parse_llm_origin(&st.read_config().llm_delegate_url)?;
    if origin != delegate {
        return None;
    }
    let key = mp_brain::delegate_api_key_from_env();
    if key.is_empty() { None } else { Some(key) }
}

fn empty_catalog(url: &str) -> Value {
    json!({ "url": url, "available": false, "models": [] })
}

async fn fetch_llm_catalog(raw: &str, bearer: Option<String>) -> Catalog {
    let Some(url) = parse_llm_origin(raw) else {
        return Catalog {
            url: raw.trim().to_string(),
            available: false,
            error: Some("invalid url".into()),
            models: Vec::new(),
        };
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(2500))
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            return Catalog {
                url,
                available: false,
                error: Some("unreachable".into()),
                models: Vec::new(),
            };
        }
    };
    let models_url = format!("{url}/v1/models");
    let mut req = client.get(&models_url);
    if let Some(token) = bearer.as_deref().filter(|t| !t.is_empty()) {
        req = req.bearer_auth(token);
    }
    match req.send().await {
        Ok(res) if res.status().as_u16() == 401 || res.status().as_u16() == 403 => Catalog {
            url,
            available: false,
            error: Some("unauthorized".into()),
            models: Vec::new(),
        },
        Ok(res) if res.status().is_success() => {
            let json = res.json::<Value>().await.unwrap_or(Value::Null);
            let mut models = uniq_models(models_from_openai(&json));
            if models.is_empty() && is_ollama(&url) {
                models = ollama_tags(&client, &url).await;
            }
            Catalog {
                url,
                available: true,
                error: None,
                models,
            }
        }
        _ if is_ollama(&url) => {
            let models = ollama_tags(&client, &url).await;
            if models.is_empty() {
                Catalog {
                    url,
                    available: false,
                    error: Some("unreachable".into()),
                    models,
                }
            } else {
                Catalog {
                    url,
                    available: true,
                    error: None,
                    models,
                }
            }
        }
        _ => Catalog {
            url,
            available: false,
            error: Some("unreachable".into()),
            models: Vec::new(),
        },
    }
}

async fn ollama_tags(client: &reqwest::Client, url: &str) -> Vec<CatalogModel> {
    let Ok(res) = client.get(format!("{url}/api/tags")).send().await else {
        return Vec::new();
    };
    if !res.status().is_success() {
        return Vec::new();
    }
    let Ok(json) = res.json::<Value>().await else {
        return Vec::new();
    };
    uniq_models(models_from_ollama(&json))
}

pub fn parse_llm_origin(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 {
        return None;
    }
    let norm = mp_brain::normalize_llm_base_url(trimmed);
    let url = reqwest::Url::parse(&norm).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    Some(mp_brain::normalize_llm_base_url(url.as_str()))
}

fn is_ollama(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("ollama") || lower.contains(":11434")
}

fn models_from_openai(json: &Value) -> Vec<CatalogModel> {
    let Some(rows) = json.get("data").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    let mut models = Vec::new();
    for row in rows {
        let Some(id) = row.get("id").and_then(|v| v.as_str()).map(str::trim) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        let max = row
            .get("max_model_len")
            .and_then(|v| v.as_u64())
            .or_else(|| row.pointer("/meta/n_ctx").and_then(|v| v.as_u64()));
        let strata = row.pointer("/meta/n_ctx").is_some();
        let owned_by = row
            .get("owned_by")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| strata.then(|| "strata".to_string()));
        let root = row
            .get("root")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| strata.then(|| id.to_string()));
        models.push(CatalogModel {
            id: id.to_string(),
            owned_by,
            max_model_len: max,
            root,
        });
    }
    models
}

fn models_from_ollama(json: &Value) -> Vec<CatalogModel> {
    let Some(rows) = json.get("models").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    let mut models = Vec::new();
    for row in rows {
        let id = row
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| row.get("model").and_then(|v| v.as_str()))
            .unwrap_or("")
            .trim();
        if id.is_empty() {
            continue;
        }
        let max = row
            .pointer("/details/context_length")
            .and_then(|v| v.as_u64());
        models.push(CatalogModel {
            id: id.to_string(),
            owned_by: Some("ollama".into()),
            max_model_len: max,
            root: None,
        });
    }
    models
}

fn uniq_models(models: Vec<CatalogModel>) -> Vec<CatalogModel> {
    let mut out = Vec::new();
    for model in models {
        let id = model.id.trim();
        if id.is_empty() || out.iter().any(|m: &CatalogModel| m.id == id) {
            continue;
        }
        out.push(CatalogModel {
            id: id.to_string(),
            ..model
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strata_catalog_uses_n_ctx_and_the_served_id() {
        let json = serde_json::json!({
            "object": "list",
            "data": [{
                "id": "qwen3.6-35b-a3b-ud-q4_k_xl",
                "object": "model",
                "status": { "value": "loaded" },
                "meta": { "n_ctx": 65536 },
                "architecture": { "input_modalities": ["text"], "output_modalities": ["text"] }
            }]
        });
        let models = uniq_models(models_from_openai(&json));
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "qwen3.6-35b-a3b-ud-q4_k_xl");
        assert_eq!(models[0].owned_by.as_deref(), Some("strata"));
        assert_eq!(models[0].max_model_len, Some(65536));
        assert_eq!(
            models[0].root.as_deref(),
            Some("qwen3.6-35b-a3b-ud-q4_k_xl")
        );
    }

    #[test]
    fn openai_catalog_keeps_owned_by_and_root() {
        let json = serde_json::json!({
            "data": [
                { "id": "Qwen3.8", "owned_by": "vllm", "max_model_len": 32768, "root": "/m/x" },
                { "id": "Qwen3.6", "owned_by": "vllm", "max_model_len": 32768 }
            ]
        });
        let models = uniq_models(models_from_openai(&json));
        assert_eq!(models[0].id, "Qwen3.6");
        assert_eq!(models[1].id, "Qwen3.8");
        assert_eq!(models[1].max_model_len, Some(32768));
        assert_eq!(models[1].root.as_deref(), Some("/m/x"));
    }

    #[test]
    fn origin_strips_v1_and_rejects_credentials() {
        assert_eq!(
            parse_llm_origin("http://127.0.0.1:8080/v1").as_deref(),
            Some("http://127.0.0.1:8080")
        );
        assert!(parse_llm_origin("http://user:pw@127.0.0.1:8080").is_none());
        assert!(parse_llm_origin("file:///etc/passwd").is_none());
    }
}
