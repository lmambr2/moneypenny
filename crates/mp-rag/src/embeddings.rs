// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;

use crate::error::{RagError, Result};
use crate::normalize::l2_normalize_batch;

pub const DEFAULT_EMBEDDING_MODEL: &str = "nomic-embed-text-v2-moe";

#[derive(Clone)]
pub enum Embedder {
    Http(EmbeddingsClient),
    Hash { dim: usize },
}

impl Embedder {
    pub async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        match self {
            Self::Http(c) => c.embed(texts).await,
            Self::Hash { dim } => Ok(texts.iter().map(|t| hash_vec(t, *dim)).collect()),
        }
    }

    pub async fn dimension(&self) -> Result<usize> {
        match self {
            Self::Http(c) => c.dimension().await,
            Self::Hash { dim } => Ok(*dim),
        }
    }

    pub fn model(&self) -> &str {
        match self {
            Self::Http(c) => c.model.as_str(),
            Self::Hash { .. } => "hash",
        }
    }
}

#[derive(Clone)]
pub struct EmbeddingsClient {
    client: reqwest::Client,
    base_url: String,
    pub model: String,
    timeout: Duration,
    dim: std::sync::Arc<Mutex<Option<usize>>>,
}

impl EmbeddingsClient {
    pub fn new(base_url: impl Into<String>, model: impl Into<String>, timeout_ms: u64) -> Self {
        let timeout = Duration::from_millis(timeout_ms.max(1_000));
        Self {
            client: reqwest::Client::builder()
                .timeout(timeout)
                .build()
                .expect("reqwest"),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            model: {
                let m = model.into();
                if m.is_empty() {
                    DEFAULT_EMBEDDING_MODEL.into()
                } else {
                    m
                }
            },
            timeout,
            dim: std::sync::Arc::new(Mutex::new(None)),
        }
    }

    pub async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let url = format!("{}/v1/embeddings", self.base_url);
        let body = serde_json::json!({
            "model": self.model,
            "input": texts,
            "keep_alive": "6h",
        });
        let res = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .json(&body)
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| RagError::Http(format!("Embedding request failed: {e}")))?;
        if !res.status().is_success() {
            return Err(RagError::Http(format!("Embedding HTTP {}", res.status())));
        }
        let parsed: EmbeddingResponse = res
            .json()
            .await
            .map_err(|e| RagError::Http(format!("Embedding decode: {e}")))?;
        let mut rows = parsed.data;
        rows.sort_by_key(|d| d.index);
        let mut out: Vec<Vec<f32>> = rows
            .into_iter()
            .map(|d| d.embedding.into_iter().map(|x| x as f32).collect())
            .collect();
        out = l2_normalize_batch(out);
        if let Some(first) = out.first() {
            *self.dim.lock().expect("dim") = Some(first.len());
        }
        Ok(out)
    }

    pub async fn dimension(&self) -> Result<usize> {
        if let Some(d) = *self.dim.lock().expect("dim") {
            return Ok(d);
        }
        let v = self.embed(&["dimension probe".into()]).await?;
        Ok(v.first().map(|x| x.len()).unwrap_or(0))
    }
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    #[serde(default)]
    data: Vec<EmbeddingRow>,
}

#[derive(Deserialize)]
struct EmbeddingRow {
    embedding: Vec<f64>,
    #[serde(default)]
    index: usize,
}

fn hash_vec(text: &str, dim: usize) -> Vec<f32> {
    let mut v = vec![0.0f32; dim.max(1)];
    for (i, b) in text.bytes().enumerate() {
        let j = i % v.len();
        v[j] += (b as f32) / 255.0;
    }
    crate::normalize::l2_normalize(&v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn hash_embedder_dim() {
        let e = Embedder::Hash { dim: 8 };
        let v = e.embed(&["hello".into(), "hello".into()]).await.unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0], v[1]);
        assert_eq!(e.dimension().await.unwrap(), 8);
    }
}
