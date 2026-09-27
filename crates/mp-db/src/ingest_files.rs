// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Seen-set for channel file drops. Same table as Node `file-drop.ts`.

use crate::{Database, Result};

pub const FILE_DROP_CHANNEL_NAME: &str = "moneypenny-drop";

#[derive(Debug, Clone)]
pub struct IngestedFile {
    pub key: String,
    pub name: String,
    pub kind: String,
    pub result: String,
    pub ingested_at: i64,
}

pub struct FileDropStore<'a> {
    db: &'a Database,
}

impl FileDropStore<'_> {
    pub fn new(db: &Database) -> FileDropStore<'_> {
        FileDropStore { db }
    }

    pub fn record(&self, key: &str, name: &str, kind: &str, result: &str) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO ingested_files (key, name, kind, result, ingested_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(key) DO UPDATE SET
                   name=excluded.name, kind=excluded.kind, result=excluded.result,
                   ingested_at=excluded.ingested_at",
                rusqlite::params![key, name, kind, result, now],
            )?;
            Ok(())
        })
    }

    pub fn recent(&self, limit: u32) -> Result<Vec<IngestedFile>> {
        let limit = limit.clamp(1, 50);
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT key, name, kind, result, ingested_at FROM ingested_files
                 ORDER BY ingested_at DESC LIMIT ?1",
            )?;
            let rows = stmt
                .query_map(rusqlite::params![limit], |r| {
                    Ok(IngestedFile {
                        key: r.get(0)?,
                        name: r.get(1)?,
                        kind: r.get(2)?,
                        result: r.get(3)?,
                        ingested_at: r.get(4)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }
}

pub fn format_ingest_status(enabled: bool, rows: &[IngestedFile]) -> String {
    let state = if enabled { "on" } else { "off" };
    if rows.is_empty() {
        return if enabled {
            format!(
                "File drop is on (channel \"{FILE_DROP_CHANNEL_NAME}\") — nothing ingested yet."
            )
        } else {
            "File drop is off. An admin can enable it in Settings → AI & Permissions.".into()
        };
    }
    let lines: Vec<String> = rows
        .iter()
        .map(|r| {
            let icon = match r.kind.as_str() {
                "doctrine" => "📎",
                "music" => "🎵",
                _ => "⚠️",
            };
            format!("{icon} {} — {}", r.name, r.result)
        })
        .collect();
    format!("File drop is {state}; last {}:\n{}", rows.len(), lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;

    #[test]
    fn recent_ingest_lines() {
        let db = Database::open_in_memory().unwrap();
        db.file_drop()
            .record("k1", "intsum.md", "doctrine", "indexed")
            .unwrap();
        let rows = db.file_drop().recent(10).unwrap();
        let text = format_ingest_status(true, &rows);
        assert!(text.contains("File drop is on"), "{text}");
        assert!(text.contains("intsum.md"), "{text}");
        assert!(text.contains("📎"), "{text}");
        assert!(format_ingest_status(false, &[]).contains("File drop is off"));
    }
}
