// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Track tag overlay + ratings. Same tables as Node `tag-store.ts`.

use serde::Serialize;

use crate::{Database, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagSource {
    Embedded,
    Analyzer,
    Api,
    Manual,
}

impl TagSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Embedded => "embedded",
            Self::Analyzer => "analyzer",
            Self::Api => "api",
            Self::Manual => "manual",
        }
    }

    fn rank(self) -> u8 {
        match self {
            Self::Embedded => 1,
            Self::Analyzer | Self::Api => 2,
            Self::Manual => 3,
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "manual" => Self::Manual,
            "api" => Self::Api,
            "analyzer" => Self::Analyzer,
            _ => Self::Embedded,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackTags {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genre: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subgenre: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mood: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub musical_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_scale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bpm: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub energy: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub danceability: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bumper: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bumper_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ops_scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rating_avg: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rating_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RatingSummary {
    pub avg: f64,
    pub count: i64,
}

pub struct TagStore<'a> {
    pub(crate) db: &'a Database,
}

impl TagStore<'_> {
    pub fn get(&self, track_key: &str) -> Result<Option<TrackTags>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT genre, subgenre, mood, musical_key, key_scale, bpm, energy, danceability,
                        bumper, bumper_kind, ops_scope, rating_avg, rating_count, source
                 FROM track_tags WHERE track_key = ?1",
            )?;
            let mut rows = stmt.query(rusqlite::params![track_key])?;
            match rows.next()? {
                Some(row) => Ok(Some(row_to_tags(row)?)),
                None => Ok(None),
            }
        })
    }

    pub fn upsert(&self, track_key: &str, patch: &TrackTags, source: TagSource) -> Result<()> {
        let existing = self.get(track_key)?;
        let now = now_ms();
        let incoming = source.rank();
        match existing {
            None => {
                self.db.with_conn(|conn| {
                    conn.execute(
                        "INSERT INTO track_tags (track_key, genre, subgenre, mood, musical_key, key_scale,
                            bpm, energy, danceability, bumper, source, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11)",
                        rusqlite::params![
                            track_key,
                            patch.genre,
                            patch.subgenre,
                            patch.mood,
                            patch.musical_key,
                            patch.key_scale,
                            patch.bpm,
                            patch.energy,
                            patch.danceability,
                            source.as_str(),
                            now
                        ],
                    )?;
                    Ok(())
                })
            }
            Some(mut cur) => {
                let existing_rank = TagSource::parse(cur.source.as_deref().unwrap_or("embedded")).rank();
                let mut changed = false;
                merge_str(&mut cur.genre, &patch.genre, incoming, existing_rank, &mut changed);
                merge_str(&mut cur.subgenre, &patch.subgenre, incoming, existing_rank, &mut changed);
                merge_str(&mut cur.mood, &patch.mood, incoming, existing_rank, &mut changed);
                merge_str(
                    &mut cur.musical_key,
                    &patch.musical_key,
                    incoming,
                    existing_rank,
                    &mut changed,
                );
                merge_str(&mut cur.key_scale, &patch.key_scale, incoming, existing_rank, &mut changed);
                if patch.bpm.is_some() && (cur.bpm.is_none() || incoming >= existing_rank) {
                    cur.bpm = patch.bpm;
                    changed = true;
                }
                if patch.energy.is_some() && (cur.energy.is_none() || incoming >= existing_rank) {
                    cur.energy = patch.energy;
                    changed = true;
                }
                if patch.danceability.is_some()
                    && (cur.danceability.is_none() || incoming >= existing_rank)
                {
                    cur.danceability = patch.danceability;
                    changed = true;
                }
                if !changed {
                    return Ok(());
                }
                let next_src = if incoming >= existing_rank {
                    source.as_str()
                } else {
                    cur.source.as_deref().unwrap_or(source.as_str())
                };
                self.db.with_conn(|conn| {
                    conn.execute(
                        "UPDATE track_tags SET genre=?1, subgenre=?2, mood=?3, musical_key=?4, key_scale=?5,
                            bpm=?6, energy=?7, danceability=?8, source=?9, updated_at=?10
                         WHERE track_key=?11",
                        rusqlite::params![
                            cur.genre,
                            cur.subgenre,
                            cur.mood,
                            cur.musical_key,
                            cur.key_scale,
                            cur.bpm,
                            cur.energy,
                            cur.danceability,
                            next_src,
                            now,
                            track_key
                        ],
                    )?;
                    Ok(())
                })
            }
        }
    }

    pub fn set_bumper(
        &self,
        track_key: &str,
        bumper: bool,
        bumper_kind: Option<&str>,
        ops_scope: Option<&str>,
    ) -> Result<()> {
        let now = now_ms();
        let flag = if bumper { 1i64 } else { 0 };
        if self.get(track_key)?.is_some() {
            self.db.with_conn(|conn| {
                conn.execute(
                    "UPDATE track_tags SET bumper=?1, bumper_kind=?2, ops_scope=?3, updated_at=?4 WHERE track_key=?5",
                    rusqlite::params![flag, bumper_kind, ops_scope, now, track_key],
                )?;
                Ok(())
            })
        } else {
            self.db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO track_tags (track_key, bumper, bumper_kind, ops_scope, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![track_key, flag, bumper_kind, ops_scope, now],
                )?;
                Ok(())
            })
        }
    }

    pub fn get_rating(&self, track_key: &str) -> Result<RatingSummary> {
        let tags = self.get(track_key)?;
        Ok(RatingSummary {
            avg: tags.as_ref().and_then(|t| t.rating_avg).unwrap_or(0.0),
            count: tags.as_ref().and_then(|t| t.rating_count).unwrap_or(0),
        })
    }

    pub fn rate(&self, track_key: &str, rater: &str, stars: i64) -> Result<()> {
        if !(1..=5).contains(&stars) {
            return Err(crate::DbError::Message("rating must be 1..5".into()));
        }
        let now = now_ms();
        self.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO track_ratings (track_key, rater, stars, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(track_key, rater) DO UPDATE SET stars=excluded.stars, updated_at=excluded.updated_at",
                rusqlite::params![track_key, rater, stars, now],
            )?;
            Ok(())
        })?;
        self.recompute_rating(track_key)
    }

    pub fn unrate(&self, track_key: &str, rater: &str) -> Result<bool> {
        let n = self.db.with_conn(|conn| {
            let n = conn.execute(
                "DELETE FROM track_ratings WHERE track_key = ?1 AND rater = ?2",
                rusqlite::params![track_key, rater],
            )?;
            Ok(n)
        })?;
        self.recompute_rating(track_key)?;
        Ok(n > 0)
    }

    /// Drop tag + rating rows for a track (library file deleted).
    pub fn remove_track(&self, track_key: &str) -> Result<()> {
        self.db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM track_ratings WHERE track_key = ?1",
                rusqlite::params![track_key],
            )?;
            conn.execute(
                "DELETE FROM track_tags WHERE track_key = ?1",
                rusqlite::params![track_key],
            )?;
            Ok(())
        })
    }

    fn recompute_rating(&self, track_key: &str) -> Result<()> {
        let now = now_ms();
        self.db.with_conn(|conn| {
            let (count, avg): (i64, Option<f64>) = conn.query_row(
                "SELECT COUNT(*), AVG(stars) FROM track_ratings WHERE track_key = ?1",
                rusqlite::params![track_key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM track_tags WHERE track_key = ?1",
                rusqlite::params![track_key],
                |r| r.get(0),
            )?;
            if exists > 0 {
                conn.execute(
                    "UPDATE track_tags SET rating_avg=?1, rating_count=?2, updated_at=?3 WHERE track_key=?4",
                    rusqlite::params![avg, count, now, track_key],
                )?;
            } else if count > 0 {
                conn.execute(
                    "INSERT INTO track_tags (track_key, rating_avg, rating_count, updated_at) VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![track_key, avg, count, now],
                )?;
            }
            Ok(())
        })
    }
}

fn merge_str(
    cur: &mut Option<String>,
    incoming: &Option<String>,
    incoming_rank: u8,
    existing_rank: u8,
    changed: &mut bool,
) {
    let Some(val) = incoming else {
        return;
    };
    let present = cur.as_ref().is_some_and(|s| !s.is_empty());
    if !present || incoming_rank >= existing_rank {
        *cur = Some(val.clone());
        *changed = true;
    }
}

fn row_to_tags(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrackTags> {
    let bumper: i64 = row.get(8)?;
    Ok(TrackTags {
        genre: row.get(0)?,
        subgenre: row.get(1)?,
        mood: row.get(2)?,
        musical_key: row.get(3)?,
        key_scale: row.get(4)?,
        bpm: row.get(5)?,
        energy: row.get(6)?,
        danceability: row.get(7)?,
        bumper: Some(bumper == 1),
        bumper_kind: row.get(9)?,
        ops_scope: row.get(10)?,
        rating_avg: row.get(11)?,
        rating_count: row.get(12)?,
        source: row.get(13)?,
    })
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
    use crate::Database;

    #[test]
    fn manual_wins_over_embedded() {
        let db = Database::open_in_memory().unwrap();
        let mut patch = TrackTags {
            genre: Some("ambient".into()),
            ..Default::default()
        };
        db.tags().upsert("t1", &patch, TagSource::Embedded).unwrap();
        patch.genre = Some("rock".into());
        db.tags().upsert("t1", &patch, TagSource::Manual).unwrap();
        let got = db.tags().get("t1").unwrap().unwrap();
        assert_eq!(got.genre.as_deref(), Some("rock"));
        patch.genre = Some("id3".into());
        db.tags().upsert("t1", &patch, TagSource::Embedded).unwrap();
        let got = db.tags().get("t1").unwrap().unwrap();
        assert_eq!(got.genre.as_deref(), Some("rock"));
    }

    #[test]
    fn rate_and_unrate() {
        let db = Database::open_in_memory().unwrap();
        db.tags().rate("t", "web:a", 4).unwrap();
        db.tags().rate("t", "web:b", 2).unwrap();
        let r = db.tags().get_rating("t").unwrap();
        assert_eq!(r.count, 2);
        assert!((r.avg - 3.0).abs() < 0.01);
        assert!(db.tags().unrate("t", "web:a").unwrap());
        let r = db.tags().get_rating("t").unwrap();
        db.tags().remove_track("t").unwrap();
        assert!(db.tags().get("t").unwrap().is_none());
        assert_eq!(r.count, 1);
        assert!((r.avg - 2.0).abs() < 0.01);
    }
}
