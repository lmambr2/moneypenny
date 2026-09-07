// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{RagError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorPoint {
    pub id: String,
    pub vector: Vec<f32>,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub struct VectorHit {
    pub id: String,
    pub score: f32,
    pub payload: Value,
}

#[derive(Clone)]
pub enum VectorStore {
    Http(HttpVectorStore),
    Memory(MemoryVectorStore),
}

impl VectorStore {
    pub async fn ensure_collection(&self, name: &str, dim: usize) -> Result<()> {
        match self {
            Self::Http(s) => s.ensure_collection(name, dim).await,
            Self::Memory(s) => s.ensure_collection(name, dim),
        }
    }

    pub async fn upsert(&self, name: &str, points: Vec<VectorPoint>) -> Result<()> {
        match self {
            Self::Http(s) => s.upsert(name, points).await,
            Self::Memory(s) => s.upsert(name, points),
        }
    }

    pub async fn search(
        &self,
        name: &str,
        vector: &[f32],
        top_k: usize,
        allowed: Option<&[String]>,
    ) -> Result<Vec<VectorHit>> {
        match self {
            Self::Http(s) => s.search(name, vector, top_k, allowed).await,
            Self::Memory(s) => s.search(name, vector, top_k, allowed),
        }
    }

    pub async fn delete_by_source(&self, name: &str, source: &str) -> Result<()> {
        match self {
            Self::Http(s) => s.delete_by_source(name, source).await,
            Self::Memory(s) => s.delete_by_source(name, source),
        }
    }
}

#[derive(Clone)]
pub struct HttpVectorStore {
    client: reqwest::Client,
    base_url: String,
    timeout: Duration,
}

impl HttpVectorStore {
    pub fn new(base_url: impl Into<String>, timeout_ms: u64) -> Self {
        let timeout = Duration::from_millis(timeout_ms.max(1_000));
        Self {
            client: reqwest::Client::builder()
                .timeout(timeout)
                .build()
                .expect("reqwest"),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            timeout,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    async fn send_json(&self, method: reqwest::Method, url: String, body: Option<Value>) -> Result<Value> {
        let mut req = self.client.request(method, &url).timeout(self.timeout);
        if let Some(b) = body {
            req = req.header("content-type", "application/json").json(&b);
        }
        let res = req
            .send()
            .await
            .map_err(|e| RagError::Http(e.to_string()))?;
        let status = res.status();
        let v: Value = res.json().await.unwrap_or(Value::Null);
        if !status.is_success() && status.as_u16() != 404 {
            return Err(RagError::Http(format!("vector HTTP {status}")));
        }
        Ok(v)
    }

    pub async fn ensure_collection(&self, name: &str, dim: usize) -> Result<()> {
        let get = self
            .send_json(
                reqwest::Method::GET,
                self.url(&format!("/collections/{name}")),
                None,
            )
            .await;
        if let Ok(data) = get {
            let existing = data
                .pointer("/result/config/params/vectors/size")
                .and_then(|v| v.as_u64());
            if let Some(ex) = existing {
                if ex as usize != dim {
                    tracing::warn!(name, existing = ex, dim, "vector collection dim mismatch");
                }
                return Ok(());
            }
        }
        self.send_json(
            reqwest::Method::PUT,
            self.url(&format!("/collections/{name}")),
            Some(serde_json::json!({ "vectors": { "size": dim, "distance": "Cosine" } })),
        )
        .await?;
        Ok(())
    }

    pub async fn upsert(&self, name: &str, points: Vec<VectorPoint>) -> Result<()> {
        if points.is_empty() {
            return Ok(());
        }
        self.send_json(
            reqwest::Method::PUT,
            format!("{}?wait=true", self.url(&format!("/collections/{name}/points"))),
            Some(serde_json::json!({ "points": points })),
        )
        .await?;
        Ok(())
    }

    pub async fn search(
        &self,
        name: &str,
        vector: &[f32],
        top_k: usize,
        allowed: Option<&[String]>,
    ) -> Result<Vec<VectorHit>> {
        let filter = allowed.filter(|a| !a.is_empty()).map(|a| {
            serde_json::json!({
                "must": [{ "key": "classification", "match": { "any": a } }]
            })
        });
        let mut body = serde_json::json!({
            "vector": vector,
            "limit": top_k,
            "with_payload": true,
        });
        if let Some(f) = filter {
            body["filter"] = f;
        }
        let data = self
            .send_json(
                reqwest::Method::POST,
                self.url(&format!("/collections/{name}/points/search")),
                Some(body),
            )
            .await?;
        let hits = data
            .get("result")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(hits
            .into_iter()
            .filter_map(|h| {
                Some(VectorHit {
                    id: h.get("id")?.to_string().trim_matches('"').to_string(),
                    score: h.get("score")?.as_f64()? as f32,
                    payload: h.get("payload").cloned().unwrap_or(Value::Null),
                })
            })
            .collect())
    }

    pub async fn delete_by_source(&self, name: &str, source: &str) -> Result<()> {
        self.send_json(
            reqwest::Method::POST,
            format!(
                "{}?wait=true",
                self.url(&format!("/collections/{name}/points/delete"))
            ),
            Some(serde_json::json!({
                "filter": { "must": [{ "key": "source", "match": { "value": source } }] }
            })),
        )
        .await?;
        Ok(())
    }
}

#[derive(Clone, Default)]
pub struct MemoryVectorStore {
    inner: std::sync::Arc<Mutex<HashMap<String, Vec<VectorPoint>>>>,
}

impl MemoryVectorStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn ensure_collection(&self, name: &str, _dim: usize) -> Result<()> {
        self.inner.lock().expect("vec").entry(name.to_string()).or_default();
        Ok(())
    }

    pub fn upsert(&self, name: &str, points: Vec<VectorPoint>) -> Result<()> {
        let mut g = self.inner.lock().expect("vec");
        let col = g.entry(name.to_string()).or_default();
        for p in points {
            if let Some(existing) = col.iter_mut().find(|x| x.id == p.id) {
                *existing = p;
            } else {
                col.push(p);
            }
        }
        Ok(())
    }

    pub fn search(
        &self,
        name: &str,
        vector: &[f32],
        top_k: usize,
        allowed: Option<&[String]>,
    ) -> Result<Vec<VectorHit>> {
        let g = self.inner.lock().expect("vec");
        let Some(col) = g.get(name) else {
            return Ok(Vec::new());
        };
        let mut scored: Vec<VectorHit> = col
            .iter()
            .filter(|p| {
                if let Some(allow) = allowed.filter(|a| !a.is_empty()) {
                    let cls = p
                        .payload
                        .get("classification")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unclassified");
                    allow.iter().any(|a| a == cls)
                } else {
                    true
                }
            })
            .map(|p| VectorHit {
                id: p.id.clone(),
                score: cosine(&p.vector, vector),
                payload: p.payload.clone(),
            })
            .collect();
        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(top_k);
        Ok(scored)
    }

    pub fn delete_by_source(&self, name: &str, source: &str) -> Result<()> {
        let mut g = self.inner.lock().expect("vec");
        if let Some(col) = g.get_mut(name) {
            col.retain(|p| {
                p.payload
                    .get("source")
                    .and_then(|v| v.as_str())
                    .map(|s| s != source)
                    .unwrap_or(true)
            });
        }
        Ok(())
    }
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    if n == 0 {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for i in 0..n {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    let d = na.sqrt() * nb.sqrt();
    if d < 1e-12 {
        0.0
    } else {
        dot / d
    }
}
