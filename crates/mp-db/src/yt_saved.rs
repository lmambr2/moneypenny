// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use crate::{Database, Result};

pub struct YtSavedStore<'a> {
    pub(crate) db: &'a Database,
}

impl YtSavedStore<'_> {
    pub fn lookup(&self, video_id: &str) -> Result<Option<String>> {
        if video_id.is_empty() {
            return Ok(None);
        }
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare("SELECT path FROM yt_saved WHERE video_id = ?1")?;
            let mut rows = stmt.query(rusqlite::params![video_id])?;
            if let Some(row) = rows.next()? {
                Ok(Some(row.get::<_, String>(0)?))
            } else {
                Ok(None)
            }
        })
    }

    pub fn insert(
        &self,
        video_id: &str,
        path: &str,
        title: &str,
        artist: &str,
        duration: i64,
    ) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.db.with_conn(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO yt_saved (video_id, path, title, artist, duration, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![video_id, path, title, artist, duration, now],
            )?;
            Ok(())
        })
    }
}
