// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Embeddings HTTP + TurboVec (or in-memory) + doctrine ingest (rewrite Phase 5).
//! `llmUrl` ≠ `embeddingUrl`. Whisper stays out of process.

mod chunk;
mod classifications;
mod doctrine;
mod embeddings;
mod error;
mod eval;
mod export;
mod frontmatter;
mod ingest;
mod kg;
mod library_tool;
mod mempalace;
mod normalize;
mod reformat;
mod store;
mod validity;
mod vector;

pub use chunk::{Chunk, chunk_id, chunk_markdown, chunk_markdown_default};
pub use classifications::{DOCTRINE_LEVELS, allowed_classifications_for};
pub use doctrine::{
    DEFAULT_DOCTRINE_TEMPLATE, DoctrineDoc, DoctrineStore, MAX_DOCTRINE_FILE_BYTES,
};
pub use embeddings::{DEFAULT_EMBEDDING_MODEL, Embedder, EmbeddingsClient};
pub use error::{RagError, Result};
pub use eval::{
    EvalAxes, EvalCase, EvalCaseResult, EvalExpect, EvalHit, EvalReport, compute_memory_axes,
    default_eval_cases, run_eval_case, run_eval_loop,
};
pub use export::{
    ExportError, export_content_type, export_filename, export_markdown, is_pandoc_available,
};
pub use frontmatter::{DocFrontmatter, parse_frontmatter};
pub use ingest::{IngestedDoc, ingest_doctrine_doc, reindex_doctrine, reindex_sources};
pub use kg::{DIARY_USAGE, KG_USAGE, KgService};
pub use library_tool::{is_library_tool, library_grounding, run_library_tool};
pub use mempalace::MemPalaceClient;
pub use reformat::{reformat_doctrine_markdown, should_skip_doctrine_reformat};
pub use store::{RetrievalStore, RetrievedChunk};
pub use validity::is_doctrine_expired;
pub use vector::{HttpVectorStore, MemoryVectorStore, VectorStore};

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

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

    /// Scripted doctrine + org-memory probes (dashboard Harness → RAG eval).
    pub async fn run_eval(&self, cases: Option<Vec<EvalCase>>) -> EvalReport {
        let cases = cases.unwrap_or_else(default_eval_cases);
        let mut doctrine = Vec::with_capacity(cases.len());
        let mut org = Vec::with_capacity(cases.len());
        for c in &cases {
            let hits = if self.rag_enabled() {
                let allowed = vec!["unclassified".to_string()];
                self.retrieval
                    .query(&c.query, Some(self.top_k()), Some(&allowed))
                    .await
                    .into_iter()
                    .map(|h| EvalHit {
                        text: h.text,
                        source: h.source,
                        score: Some(h.score),
                        classification: Some(h.classification),
                    })
                    .collect()
            } else {
                Vec::new()
            };
            doctrine.push(hits);
            org.push(self.kg.search_org(&c.query, 8).await);
        }
        run_eval_loop(&cases, &doctrine, &org)
    }
}

pub fn build_embedder(url: &str, model: &str) -> Embedder {
    let url = url.trim();
    if url.is_empty() {
        return Embedder::Disabled;
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
