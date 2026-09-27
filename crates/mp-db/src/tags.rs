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

/// Filters for `select_tracks` / the `select_tracks` LLM tool. Unknown JSON keys are dropped.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TagSelect {
    pub mood: Vec<String>,
    pub genre_any: Vec<String>,
    pub subgenre_any: Vec<String>,
    pub bpm_min: Option<f64>,
    pub bpm_max: Option<f64>,
    pub musical_key: Option<String>,
    pub energy_min: Option<f64>,
    pub energy_max: Option<f64>,
    pub rating_min: Option<f64>,
    pub limit: Option<f64>,
}

/// `None` when `raw` is not a JSON object (the command replies with usage).
pub fn parse_tag_select(raw: &str) -> Option<TagSelect> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let obj = v.as_object()?;
    let str_arr = |key: &str| -> Vec<String> {
        obj.get(key)
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    let num = |key: &str| -> Option<f64> {
        let v = obj.get(key)?;
        match v {
            serde_json::Value::Number(n) => n.as_f64().filter(|n| n.is_finite()),
            serde_json::Value::String(s) => s.parse::<f64>().ok().filter(|n| n.is_finite()),
            serde_json::Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            _ => None,
        }
    };
    Some(TagSelect {
        mood: str_arr("mood"),
        genre_any: str_arr("genreAny"),
        subgenre_any: str_arr("subgenreAny"),
        bpm_min: num("bpmMin"),
        bpm_max: num("bpmMax"),
        musical_key: obj
            .get("musicalKey")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        energy_min: num("energyMin"),
        energy_max: num("energyMax"),
        rating_min: num("ratingMin"),
        limit: num("limit"),
    })
}

fn push_any(
    clauses: &mut Vec<String>,
    params: &mut Vec<rusqlite::types::Value>,
    col: &str,
    vals: &[String],
) {
    if vals.is_empty() {
        return;
    }
    let placeholders = vec!["?"; vals.len()].join(",");
    clauses.push(format!("LOWER({col}) IN ({placeholders})"));
    for v in vals {
        params.push(rusqlite::types::Value::Text(v.to_lowercase()));
    }
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

    /// IMDB-style Bayesian mean: `(C*m + Σstars) / (C + n)`, C = 5.
    /// Unrated tracks score at the global mean (3 when nothing is rated).
    pub fn smoothed_score(&self, track_key: &str) -> Result<f64> {
        let m = self.global_mean()?;
        let rating = self.get_rating(track_key)?;
        if rating.count == 0 {
            return Ok(m);
        }
        let c = 5.0;
        let n = rating.count as f64;
        Ok((c * m + rating.avg * n) / (c + n))
    }

    fn global_mean(&self) -> Result<f64> {
        self.db.with_conn(|conn| {
            let avg: Option<f64> =
                conn.query_row("SELECT AVG(stars) FROM track_ratings", [], |r| r.get(0))?;
            Ok(avg.unwrap_or(3.0))
        })
    }

    /// Tag-driven selection. Bumper-flagged rows are excluded. `rating_min`
    /// thresholds the smoothed score, not the raw average.
    pub fn select_tracks(&self, f: &TagSelect) -> Result<Vec<String>> {
        let keys = self.db.with_conn(|conn| {
            let mut clauses = vec!["bumper = 0".to_string()];
            let mut params: Vec<rusqlite::types::Value> = Vec::new();
            push_any(&mut clauses, &mut params, "mood", &f.mood);
            push_any(&mut clauses, &mut params, "genre", &f.genre_any);
            push_any(&mut clauses, &mut params, "subgenre", &f.subgenre_any);
            if let Some(n) = f.bpm_min {
                clauses.push("bpm >= ?".into());
                params.push(rusqlite::types::Value::Real(n));
            }
            if let Some(n) = f.bpm_max {
                clauses.push("bpm <= ?".into());
                params.push(rusqlite::types::Value::Real(n));
            }
            if let Some(key) = f.musical_key.as_deref() {
                clauses.push("LOWER(musical_key) = ?".into());
                params.push(rusqlite::types::Value::Text(key.to_lowercase()));
            }
            if let Some(n) = f.energy_min {
                clauses.push("energy >= ?".into());
                params.push(rusqlite::types::Value::Real(n));
            }
            if let Some(n) = f.energy_max {
                clauses.push("energy <= ?".into());
                params.push(rusqlite::types::Value::Real(n));
            }
            let sql = format!(
                "SELECT track_key FROM track_tags WHERE {}",
                clauses.join(" AND ")
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(params.iter()), |r| r.get(0))?
                .collect::<std::result::Result<Vec<String>, _>>()?;
            Ok(rows)
        })?;
        let mut keys = keys;
        if let Some(min) = f.rating_min {
            let mut kept = Vec::new();
            for key in keys {
                if self.smoothed_score(&key)? >= min {
                    kept.push(key);
                }
            }
            keys = kept;
        }
        let cap = match f.limit {
            Some(n) if n.is_finite() => (n.min(100.0)).max(1.0) as usize,
            _ => 25,
        };
        keys.truncate(cap);
        Ok(keys)
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

    #[test]
    fn select_tracks_filters_case_and_excludes_bumpers() {
        let db = Database::open_in_memory().unwrap();
        let tags = |genre: &str, mood: &str, bpm: i64| TrackTags {
            genre: Some(genre.into()),
            mood: Some(mood.into()),
            bpm: Some(bpm),
            ..Default::default()
        };
        db.tags()
            .upsert("calm1", &tags("Ambient", "Calm", 90), TagSource::Analyzer)
            .unwrap();
        db.tags()
            .upsert(
                "calm2",
                &tags("synthwave", "calm", 105),
                TagSource::Analyzer,
            )
            .unwrap();
        db.tags()
            .upsert("hype", &tags("dnb", "hype", 174), TagSource::Analyzer)
            .unwrap();
        db.tags()
            .upsert("jingle", &tags("ambient", "calm", 80), TagSource::Manual)
            .unwrap();
        db.tags().set_bumper("jingle", true, None, None).unwrap();

        let calm = parse_tag_select(r#"{"mood":["calm"],"bpmMax":110}"#).unwrap();
        let mut keys = db.tags().select_tracks(&calm).unwrap();
        keys.sort();
        assert_eq!(keys, vec!["calm1", "calm2"]);
        let genre = parse_tag_select(r#"{"genreAny":["AMBIENT"]}"#).unwrap();
        assert_eq!(db.tags().select_tracks(&genre).unwrap(), vec!["calm1"]);
    }

    #[test]
    fn select_tracks_rating_min_uses_smoothed_score() {
        let db = Database::open_in_memory().unwrap();
        let ambient = TrackTags {
            genre: Some("ambient".into()),
            ..Default::default()
        };
        for k in ["a", "b", "c"] {
            db.tags().upsert(k, &ambient, TagSource::Analyzer).unwrap();
        }
        for i in 0..10 {
            db.tags().rate("a", &format!("ts:a{i}"), 5).unwrap();
            db.tags().rate("c", &format!("ts:c{i}"), 1).unwrap();
        }
        db.tags().rate("b", "ts:x", 5).unwrap();
        let f = parse_tag_select(r#"{"genreAny":["ambient"],"ratingMin":4}"#).unwrap();
        assert_eq!(db.tags().select_tracks(&f).unwrap(), vec!["a"]);
        let limited = parse_tag_select(r#"{"genreAny":["ambient"],"limit":2}"#).unwrap();
        assert_eq!(db.tags().select_tracks(&limited).unwrap().len(), 2);
        assert!(db.tags().smoothed_score("a").unwrap() > db.tags().smoothed_score("b").unwrap());
        assert!(db.tags().smoothed_score("b").unwrap() < 5.0);
    }

    #[test]
    fn parse_tag_select_rejects_malformed_json() {
        assert!(parse_tag_select("{nope").is_none());
        assert!(parse_tag_select("[]").is_none());
        let ok = parse_tag_select(r#"{"bpmMin":"90","genreAny":"rock"}"#).unwrap();
        assert_eq!(ok.bpm_min, Some(90.0));
        assert!(ok.genre_any.is_empty());
    }
}
