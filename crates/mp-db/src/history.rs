// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use std::collections::HashSet;

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

    /// Song ids played at least `max_plays` times inside the rolling window.
    /// `cooldown_hours` is a SQLite datetime modifier (`-24 hours`).
    pub fn saturated_song_ids(
        &self,
        bot_id: &str,
        max_plays: u32,
        cooldown_hours: f64,
    ) -> Result<HashSet<String>> {
        if bot_id.is_empty() || max_plays < 1 || !(cooldown_hours > 0.0) {
            return Ok(HashSet::new());
        }
        let hours = cooldown_hours.clamp(0.25, 24.0 * 30.0);
        let modifier = format!("-{hours} hours");
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT songId FROM play_history
                 WHERE botId = ?1 AND playedAt >= datetime('now', ?2)
                 GROUP BY songId
                 HAVING COUNT(*) >= ?3",
            )?;
            let rows = stmt.query_map(rusqlite::params![bot_id, modifier, max_plays], |row| {
                row.get::<_, String>(0)
            })?;
            let mut out = HashSet::new();
            for id in rows {
                let id = id?;
                if !id.is_empty() {
                    out.insert(id);
                }
            }
            Ok(out)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saturated_ids_respect_count_and_bot() {
        let db = Database::open_in_memory().unwrap();
        let hist = db.play_history();
        hist.insert("bot", "hot", "Hot", "A", "", "local", "")
            .unwrap();
        hist.insert("bot", "hot", "Hot", "A", "", "local", "")
            .unwrap();
        hist.insert("bot", "once", "Once", "A", "", "local", "")
            .unwrap();
        hist.insert("other", "once", "Once", "A", "", "local", "")
            .unwrap();
        let one = hist.saturated_song_ids("bot", 1, 24.0).unwrap();
        assert!(one.contains("hot") && one.contains("once"), "{one:?}");
        let two = hist.saturated_song_ids("bot", 2, 24.0).unwrap();
        assert!(two.contains("hot") && !two.contains("once"), "{two:?}");
        assert!(hist.saturated_song_ids("missing", 1, 24.0).unwrap().is_empty());
        assert!(hist.saturated_song_ids("bot", 1, 0.0).unwrap().is_empty());
    }
}
