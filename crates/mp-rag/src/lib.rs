// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Embeddings HTTP + TurboVec (or in-memory) + doctrine ingest (rewrite Phase 5).
//! `llmUrl` ≠ `embeddingUrl`. Whisper stays out of process.

mod chunk;
mod classifications;
mod doctrine;
mod embeddings;
mod error;
mod export;
mod frontmatter;
mod ingest;
mod normalize;
mod reformat;
mod store;
mod validity;
mod vector;
mod mempalace;
mod kg;

pub use chunk::{chunk_id, chunk_markdown, chunk_markdown_default, Chunk};
pub use classifications::{allowed_classifications_for, DOCTRINE_LEVELS};
pub use doctrine::{
    DoctrineDoc, DoctrineStore, DEFAULT_DOCTRINE_TEMPLATE, MAX_DOCTRINE_FILE_BYTES,
};
pub use embeddings::{Embedder, EmbeddingsClient, DEFAULT_EMBEDDING_MODEL};
pub use error::{RagError, Result};
pub use export::{
    export_content_type, export_filename, export_markdown, is_pandoc_available, ExportError,
};
pub use frontmatter::{parse_frontmatter, DocFrontmatter};
pub use ingest::{ingest_doctrine_doc, reindex_doctrine, reindex_sources, IngestedDoc};
pub use reformat::{reformat_doctrine_markdown, should_skip_doctrine_reformat};
pub use store::{RetrievedChunk, RetrievalStore};
pub use validity::is_doctrine_expired;
pub use vector::{HttpVectorStore, MemoryVectorStore, VectorStore};
pub use kg::{KgService, DIARY_USAGE, KG_USAGE};
pub use mempalace::MemPalaceClient;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

/// Process-wide RAG + flags (Settings toggles are in-memory during dual-run).
pub struct RagRuntime {
    pub retrieval: Arc<RetrievalStore>,
    pub doctrine: Arc<DoctrineStore>,
    pub kg: Arc<KgService>,
    rag_enabled: AtomicBool,
    memory_enabled: AtomicBool,
    mempalace_enabled: AtomicBool,
    top_k: AtomicUsize,
    pub mempalace: Option<MemPalaceClient>,
}

impl RagRuntime {
    pub fn new(
        retrieval: Arc<RetrievalStore>,
        doctrine: Arc<DoctrineStore>,
        rag_enabled: bool,
        memory_enabled: bool,
        top_k: usize,
    ) -> Arc<Self> {
        let mempalace = MemPalaceClient::from_env();
        let kg = KgService::new(doctrine.database());
        kg.set_mempalace(mempalace.clone(), false);
        Arc::new(Self {
            retrieval,
            doctrine,
            kg,
            rag_enabled: AtomicBool::new(rag_enabled),
            memory_enabled: AtomicBool::new(memory_enabled),
            mempalace_enabled: AtomicBool::new(false),
            top_k: AtomicUsize::new(top_k.max(1)),
            mempalace,
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
    pub fn mempalace_enabled(&self) -> bool {
        self.mempalace_enabled.load(Ordering::SeqCst) && self.mempalace.is_some()
    }
    pub fn set_mempalace_enabled(&self, v: bool) {
        self.mempalace_enabled.store(v, Ordering::SeqCst);
        self.kg
            .set_mempalace(self.mempalace.clone(), v && self.mempalace.is_some());
    }
    pub fn kg_enabled(&self) -> bool {
        self.kg.kg_enabled()
    }
    pub fn set_kg_enabled(&self, v: bool) {
        self.kg.set_kg_enabled(v);
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
