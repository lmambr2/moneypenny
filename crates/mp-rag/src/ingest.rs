// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use serde::Serialize;

use crate::doctrine::DoctrineStore;
use crate::error::{RagError, Result};
use crate::frontmatter::{metadata_matches_registry, parse_frontmatter};
use crate::store::RetrievalStore;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestedDoc {
    pub source: String,
    pub classification: String,
    pub chunks: usize,
}

pub async fn ingest_doctrine_doc(
    retrieval: &RetrievalStore,
    doctrine: &DoctrineStore,
    source: &str,
    content: &str,
) -> Result<IngestedDoc> {
    let fm = parse_frontmatter(content);
    let saved = doctrine
        .save_file(source, content)?
        .ok_or_else(|| RagError::Message(format!("invalid doctrine filename: {source}")))?;
    let chunks = retrieval
        .ingest(
            &saved,
            &fm.body,
            &fm.classification,
            &fm.tags,
            fm.valid_until.as_deref().unwrap_or(""),
        )
        .await?;
    doctrine.upsert(&crate::doctrine::DoctrineDoc {
        source: saved.clone(),
        classification: fm.classification.clone(),
        tags: fm.tags,
        valid_until: fm.valid_until,
        chunks: chunks as i64,
        bytes: content.len() as i64,
        updated_at: now_ms(),
    })?;
    Ok(IngestedDoc {
        source: saved,
        classification: fm.classification,
        chunks,
    })
}

pub async fn purge_orphaned(
    retrieval: &RetrievalStore,
    doctrine: &DoctrineStore,
) -> Result<()> {
    let on_disk: std::collections::HashSet<String> = doctrine.files().into_iter().collect();
    for doc in doctrine.list() {
        if !on_disk.contains(&doc.source) {
            retrieval.purge(&doc.source).await?;
            doctrine.remove(&doc.source);
        }
    }
    Ok(())
}

fn should_reingest(doctrine: &DoctrineStore, source: &str, content: &str, force: bool) -> bool {
    if force {
        return true;
    }
    let Some(existing) = doctrine.get(source) else {
        return true;
    };
    if existing.bytes != content.len() as i64 {
        return true;
    }
    let fm = parse_frontmatter(content);
    !metadata_matches_registry(
        &fm,
        &existing.classification,
        &existing.tags,
        existing.valid_until.as_deref(),
    )
}

pub async fn reindex_sources(
    retrieval: &RetrievalStore,
    doctrine: &DoctrineStore,
    sources: impl IntoIterator<Item = String>,
    force: bool,
) -> Result<Vec<IngestedDoc>> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for raw in sources {
        let Some(source) = doctrine.safe_name(&raw) else {
            continue;
        };
        if !seen.insert(source.clone()) {
            continue;
        }
        if let Some(content) = doctrine.read_file(&source) {
            if !should_reingest(doctrine, &source, &content, force) {
                continue;
            }
            out.push(ingest_doctrine_doc(retrieval, doctrine, &source, &content).await?);
            continue;
        }
        if doctrine.get(&source).is_some() {
            retrieval.purge(&source).await?;
            doctrine.remove(&source);
        }
    }
    Ok(out)
}

pub async fn reindex_doctrine(
    retrieval: &RetrievalStore,
    doctrine: &DoctrineStore,
) -> Result<Vec<IngestedDoc>> {
    purge_orphaned(retrieval, doctrine).await?;
    let mut out = Vec::new();
    for source in doctrine.files() {
        let Some(content) = doctrine.read_file(&source) else {
            continue;
        };
        if !should_reingest(doctrine, &source, &content, false) {
            continue;
        }
        out.push(ingest_doctrine_doc(retrieval, doctrine, &source, &content).await?);
    }
    Ok(out)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
