// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Embeddings HTTP + TurboVec (or in-memory) + doctrine ingest (rewrite Phase 5).
//! `llmUrl` ≠ `embeddingUrl`. Whisper stays out of process.

mod chunk;
mod classifications;
mod doctrine;
mod embeddings;
mod error;
mod frontmatter;
mod ingest;
mod normalize;
mod store;
mod validity;
mod vector;

pub use chunk::{chunk_id, chunk_markdown, chunk_markdown_default, Chunk};
pub use classifications::{allowed_classifications_for, DOCTRINE_LEVELS};
pub use doctrine::{
    DoctrineDoc, DoctrineStore, DEFAULT_DOCTRINE_TEMPLATE, MAX_DOCTRINE_FILE_BYTES,
};
pub use embeddings::{Embedder, EmbeddingsClient, DEFAULT_EMBEDDING_MODEL};
pub use error::{RagError, Result};
pub use frontmatter::{parse_frontmatter, DocFrontmatter};
pub use ingest::{ingest_doctrine_doc, reindex_doctrine, reindex_sources, IngestedDoc};
pub use store::{RetrievedChunk, RetrievalStore};
pub use validity::is_doctrine_expired;
pub use vector::{HttpVectorStore, MemoryVectorStore, VectorStore};

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

/// Process-wide RAG + flags (Settings toggles are in-memory during dual-run).
pub struct RagRuntime {
    pub retrieval: Arc<RetrievalStore>,
    pub doctrine: Arc<DoctrineStore>,
    rag_enabled: AtomicBool,
    memory_enabled: AtomicBool,
    top_k: AtomicUsize,
}

impl RagRuntime {
    pub fn new(
        retrieval: Arc<RetrievalStore>,
        doctrine: Arc<DoctrineStore>,
        rag_enabled: bool,
        memory_enabled: bool,
        top_k: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            retrieval,
            doctrine,
            rag_enabled: AtomicBool::new(rag_enabled),
            memory_enabled: AtomicBool::new(memory_enabled),
            top_k: AtomicUsize::new(top_k.max(1)),
        })
    }

    pub fn rag_enabled(&self) -> bool {
        self.rag_enabled.load(Ordering::SeqCst)
    }
    pub fn memory_enabled(&self) -> bool {
        self.memory_enabled.load(Ordering::SeqCst)
    }
    pub fn top_k(&self) -> usize {
        self.top_k.load(Ordering::SeqCst)
    }
    pub fn set_rag_enabled(&self, v: bool) {
        self.rag_enabled.store(v, Ordering::SeqCst);
    }
    pub fn set_memory_enabled(&self, v: bool) {
        self.memory_enabled.store(v, Ordering::SeqCst);
    }
    pub fn set_top_k(&self, v: usize) {
        self.top_k.store(v.max(1), Ordering::SeqCst);
    }
}

pub fn build_embedder(url: &str, model: &str) -> Embedder {
    let url = url.trim();
    if url.is_empty() {
        return Embedder::Hash { dim: 32 };
    }
    Embedder::Http(EmbeddingsClient::new(url, model, 600_000))
}

pub fn build_vector_store(url: &str) -> VectorStore {
    let url = url.trim();
    if url.is_empty() {
        return VectorStore::Memory(MemoryVectorStore::new());
    }
    VectorStore::Http(HttpVectorStore::new(url, 30_000))
}
