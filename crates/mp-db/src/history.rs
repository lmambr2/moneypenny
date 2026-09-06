// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use crate::{Database, Result};

#[derive(Debug, Clone)]
pub struct PlayHistoryRow {
    pub song_id: String,
    pub song_name: String,
    pub artist: String,
    pub album: String,
    pub platform: String,
    pub cover_url: String,
    pub played_at: String,
}

pub struct PlayHistoryStore<'a> {
    pub(crate) db: &'a Database,
}

impl PlayHistoryStore<'_> {
    pub fn insert(
        &self,
        bot_id: &str,
        song_id: &str,
        song_name: &str,
        artist: &str,
        album: &str,
        platform: &str,
        cover_url: &str,
    ) -> Result<()> {
        self.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO play_history (botId, songId, songName, artist, album, platform, coverUrl)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![bot_id, song_id, song_name, artist, album, platform, cover_url],
            )?;
            Ok(())
        })
    }

    pub fn list(&self, bot_id: &str, limit: u32) -> Result<Vec<PlayHistoryRow>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT songId, songName, artist, album, platform, coverUrl, playedAt
                 FROM play_history WHERE botId = ?1 ORDER BY id DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(rusqlite::params![bot_id, limit], |row| {
                Ok(PlayHistoryRow {
                    song_id: row.get(0)?,
                    song_name: row.get(1)?,
                    artist: row.get(2)?,
                    album: row.get(3)?,
                    platform: row.get(4)?,
                    cover_url: row.get(5)?,
                    played_at: row.get(6)?,
                })
            })?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
    }
}
