// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::json;

use crate::chunk::chunk_markdown_default;
use crate::embeddings::Embedder;
use crate::error::{RagError, Result};
use crate::validity::is_doctrine_expired;
use crate::vector::{VectorPoint, VectorStore};

const EMBED_BATCH_SIZE: usize = 8;

#[derive(Debug, Clone, Serialize)]
pub struct RetrievedChunk {
    pub text: String,
    pub source: String,
    pub score: f64,
    pub classification: String,
}

pub struct RetrievalStore {
    embeddings: Embedder,
    vectors: VectorStore,
    collection: String,
    top_k: usize,
    ready: AtomicBool,
}

impl RetrievalStore {
    pub fn new(embeddings: Embedder, vectors: VectorStore, collection: String, top_k: usize) -> Self {
        Self {
            embeddings,
            vectors,
            collection,
            top_k: top_k.max(1),
            ready: AtomicBool::new(false),
        }
    }

    pub fn collection(&self) -> &str {
        &self.collection
    }

    pub fn model(&self) -> &str {
        self.embeddings.model()
    }

    pub async fn init(&self) -> Result<()> {
        if self.ready.load(Ordering::SeqCst) {
            return Ok(());
        }
        let dim = self.embeddings.dimension().await?;
        self.vectors.ensure_collection(&self.collection, dim).await?;
        self.ready.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub async fn ingest(
        &self,
        source: &str,
        text: &str,
        classification: &str,
        tags: &[String],
        valid_until: &str,
    ) -> Result<usize> {
        self.init().await?;
        let chunks = chunk_markdown_default(source, text);
        if chunks.is_empty() {
            return Ok(0);
        }
        let mut vectors = Vec::new();
        for batch in chunks.chunks(EMBED_BATCH_SIZE) {
            let texts: Vec<String> = batch.iter().map(|c| c.text.clone()).collect();
            vectors.extend(self.embeddings.embed(&texts).await?);
        }
        let points: Vec<VectorPoint> = chunks
            .iter()
            .zip(vectors.into_iter())
            .map(|(c, vector)| VectorPoint {
                id: c.id.clone(),
                vector,
                payload: json!({
                    "text": c.text,
                    "source": c.source,
                    "index": c.index,
                    "classification": classification,
                    "tags": tags,
                    "valid_until": valid_until,
                }),
            })
            .collect();
        let n = points.len();
        self.vectors
            .delete_by_source(&self.collection, source)
            .await?;
        self.vectors.upsert(&self.collection, points).await?;
        Ok(n)
    }

    pub async fn purge(&self, source: &str) -> Result<()> {
        self.init().await?;
        self.vectors.delete_by_source(&self.collection, source).await
    }

    pub async fn query(
        &self,
        text: &str,
        top_k: Option<usize>,
        allowed: Option<&[String]>,
    ) -> Vec<RetrievedChunk> {
        match self.query_strict(text, top_k, allowed).await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "RAG query failed — answering without retrieved context");
                Vec::new()
            }
        }
    }

    pub async fn query_strict(
        &self,
        text: &str,
        top_k: Option<usize>,
        allowed: Option<&[String]>,
    ) -> Result<Vec<RetrievedChunk>> {
        if text.trim().is_empty() {
            return Ok(Vec::new());
        }
        self.init().await?;
        let mut vecs = self.embeddings.embed(&[text.to_string()]).await?;
        let vec = vecs.pop().ok_or_else(|| RagError::Message("Embedding service returned no vector".into()))?;
        let limit = top_k.unwrap_or(self.top_k).max(1);
        let fetch_k = (limit * 4).max(limit);
        let hits = self
            .vectors
            .search(&self.collection, &vec, fetch_k, allowed)
            .await?;
        let now = now_ms();
        let chunks: Vec<RetrievedChunk> = hits
            .into_iter()
            .filter(|h| {
                let vu = h
                    .payload
                    .get("valid_until")
                    .and_then(|v| v.as_str());
                !is_doctrine_expired(vu.filter(|s| !s.is_empty()), now)
            })
            .map(|h| RetrievedChunk {
                text: payload_str(&h.payload, "text"),
                source: payload_str(&h.payload, "source"),
                score: h.score as f64,
                classification: {
                    let c = payload_str(&h.payload, "classification");
                    if c.is_empty() {
                        "unclassified".into()
                    } else {
                        c
                    }
                },
            })
            .take(limit)
            .collect();
        Ok(chunks)
    }
}

fn payload_str(payload: &serde_json::Value, key: &str) -> String {
    payload
        .get(key)
        .map(|v| match v {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embeddings::Embedder;
    use crate::vector::{MemoryVectorStore, VectorStore};

    #[tokio::test]
    async fn ingest_and_query_in_memory() {
        let store = RetrievalStore::new(
            Embedder::Hash { dim: 32 },
            VectorStore::Memory(MemoryVectorStore::new()),
            "test".into(),
            4,
        );
        let n = store
            .ingest(
                "combat.md",
                "# Formation\nHeavies establish the perimeter before jump.",
                "unclassified",
                &[],
                "",
            )
            .await
            .unwrap();
        assert!(n >= 1);
        let hits = store
            .query("formation perimeter", Some(3), Some(&["unclassified".into()]))
            .await;
        assert!(!hits.is_empty());
        assert_eq!(hits[0].source, "combat.md");
    }

    #[tokio::test]
    async fn classification_filter() {
        let store = RetrievalStore::new(
            Embedder::Hash { dim: 16 },
            VectorStore::Memory(MemoryVectorStore::new()),
            "t".into(),
            4,
        );
        store
            .ingest("s.md", "# Secret\nclassified ops only", "secret", &[], "")
            .await
            .unwrap();
        let none = store
            .query("classified ops", Some(4), Some(&["unclassified".into()]))
            .await;
        assert!(none.is_empty());
        let hit = store
            .query("classified ops", Some(4), Some(&["secret".into()]))
            .await;
        assert_eq!(hit.len(), 1);
    }
}
