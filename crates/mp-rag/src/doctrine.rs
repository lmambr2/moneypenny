// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mp_db::Database;
use serde::Serialize;

use crate::error::Result;

pub const MAX_DOCTRINE_FILE_BYTES: usize = 15 * 1024 * 1024;

pub const DEFAULT_DOCTRINE_TEMPLATE: &str = "---\nclassification: unclassified\ntags: []\n---\n\n# Title\n\nBody markdown…\n";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctrineDoc {
    pub source: String,
    pub classification: String,
    pub tags: Vec<String>,
    pub valid_until: Option<String>,
    pub chunks: i64,
    pub bytes: i64,
    pub updated_at: i64,
}

pub struct DoctrineStore {
    db: Arc<Database>,
    pub dir: PathBuf,
}

impl DoctrineStore {
    pub fn new(db: Arc<Database>, data_dir: &Path) -> Result<Self> {
        let dir = data_dir.join("doctrine");
        fs::create_dir_all(&dir)?;
        Ok(Self { db, dir })
    }

    pub fn database(&self) -> Arc<Database> {
        Arc::clone(&self.db)
    }

    pub fn safe_name(&self, name: &str) -> Option<String> {
        let raw = name.replace('\\', "/").trim().to_string();
        if raw.is_empty() {
            return None;
        }
        if !raw.to_ascii_lowercase().ends_with(".md")
            && !raw.to_ascii_lowercase().ends_with(".markdown")
        {
            return None;
        }
        let parts: Vec<&str> = raw.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
        if parts.is_empty() || parts.iter().any(|p| *p == "..") {
            return None;
        }
        Some(parts.join("/"))
    }

    pub fn normalize_source(input: &str) -> String {
        let raw = input.replace('\\', "/").trim().to_string();
        if raw.to_ascii_lowercase().ends_with(".md")
            || raw.to_ascii_lowercase().ends_with(".markdown")
        {
            raw
        } else if raw.is_empty() {
            raw
        } else {
            format!("{raw}.md")
        }
    }

    fn file_path(&self, source: &str) -> Option<PathBuf> {
        let safe = self.safe_name(source)?;
        Some(self.dir.join(safe))
    }

    pub fn save_file(&self, name: &str, content: &str) -> Result<Option<String>> {
        let Some(source) = self.safe_name(name) else {
            return Ok(None);
        };
        let p = self.dir.join(&source);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent)?;
        }
        if p.exists() {
            if let Ok(existing) = fs::read_to_string(&p) {
                if existing == content {
                    return Ok(Some(source));
                }
            }
        }
        fs::write(&p, content)?;
        Ok(Some(source))
    }

    pub fn read_file(&self, source: &str) -> Option<String> {
        let p = self.file_path(source)?;
        fs::read_to_string(p).ok()
    }

    pub fn upsert(&self, meta: &DoctrineDoc) -> Result<()> {
        let tags = meta.tags.join(",");
        self.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO doctrine_docs (source, classification, tags, valid_until, chunks, bytes, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(source) DO UPDATE SET
                   classification=excluded.classification, tags=excluded.tags,
                   valid_until=excluded.valid_until,
                   chunks=excluded.chunks, bytes=excluded.bytes, updated_at=excluded.updated_at",
                rusqlite::params![
                    meta.source,
                    meta.classification,
                    tags,
                    meta.valid_until,
                    meta.chunks,
                    meta.bytes,
                    meta.updated_at
                ],
            )?;
            Ok(())
        })?;
        Ok(())
    }

    pub fn list(&self) -> Vec<DoctrineDoc> {
        self.db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT source, classification, tags, valid_until, chunks, bytes, updated_at
                     FROM doctrine_docs ORDER BY source ASC",
                )?;
                let rows = stmt.query_map([], row_to_doc)?;
                Ok(rows.filter_map(|r| r.ok()).collect())
            })
            .unwrap_or_default()
    }

    pub fn get(&self, source: &str) -> Option<DoctrineDoc> {
        self.db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT source, classification, tags, valid_until, chunks, bytes, updated_at
                     FROM doctrine_docs WHERE source = ?1",
                )?;
                let mut rows = stmt.query(rusqlite::params![source])?;
                match rows.next()? {
                    Some(row) => Ok(Some(row_to_doc(row)?)),
                    None => Ok(None),
                }
            })
            .ok()
            .flatten()
    }

    pub fn remove(&self, source: &str) -> bool {
        let Some(safe) = self.safe_name(source) else {
            return false;
        };
        let p = self.dir.join(&safe);
        let _ = fs::remove_file(p);
        self.db
            .with_conn(|conn| {
                let n = conn.execute(
                    "DELETE FROM doctrine_docs WHERE source = ?1",
                    rusqlite::params![safe],
                )?;
                Ok(n > 0)
            })
            .unwrap_or(false)
    }

    pub fn files(&self) -> Vec<String> {
        let mut out = Vec::new();
        walk_md(&self.dir, &self.dir, &mut out);
        out.sort();
        out
    }
}

fn walk_md(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        if path.is_dir() {
            walk_md(root, &path, out);
        } else {
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if name.ends_with(".md") || name.ends_with(".markdown") {
                if let Ok(rel) = path.strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
}

fn row_to_doc(row: &rusqlite::Row<'_>) -> rusqlite::Result<DoctrineDoc> {
    let tags: String = row.get(2)?;
    Ok(DoctrineDoc {
        source: row.get(0)?,
        classification: row.get(1)?,
        tags: tags
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        valid_until: row.get(3)?,
        chunks: row.get(4)?,
        bytes: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let dir = std::env::temp_dir().join(format!(
            "mp-doc-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let st = DoctrineStore::new(db, &dir).unwrap();
        assert!(st.safe_name("../x.md").is_none());
        assert!(st.safe_name("ok.md").is_some());
        assert!(st.safe_name("intel/intsum.md").is_some());
        let _ = fs::remove_dir_all(dir.join("doctrine"));
        let _ = fs::remove_dir_all(dir);
    }
}
