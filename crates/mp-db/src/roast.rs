// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use crate::{Database, Result};

#[derive(Debug, Clone)]
pub struct RoastQuote {
    pub id: i64,
    pub user_uid: String,
    pub user_name: String,
    pub text: String,
    pub created_at: i64,
    pub score: Option<i64>,
    pub reason: Option<String>,
}

pub struct RoastStore<'a> {
    pub(crate) db: &'a Database,
}

impl RoastStore<'_> {
    pub fn add(&self, user_uid: &str, user_name: &str, text: &str) -> Result<()> {
        let now = now_ms();
        self.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO roast_quotes (user_uid, user_name, text, created_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![user_uid, user_name, text, now],
            )?;
            Ok(())
        })
    }

    pub fn has_recent_duplicate(&self, user_uid: &str, text: &str, within_ms: i64) -> Result<bool> {
        let since = now_ms() - within_ms;
        self.db.with_conn(|conn| {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM roast_quotes WHERE user_uid = ?1 AND text = ?2 AND created_at > ?3",
                rusqlite::params![user_uid, text, since],
                |r| r.get(0),
            )?;
            Ok(n > 0)
        })
    }

    pub fn ungraded(&self, limit: i64) -> Result<Vec<RoastQuote>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, user_uid, user_name, text, created_at, score, reason
                 FROM roast_quotes WHERE score IS NULL ORDER BY created_at ASC LIMIT ?1",
            )?;
            let rows = stmt.query_map(rusqlite::params![limit], row_to_quote)?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
    }

    pub fn set_grade(&self, id: i64, score: i64, reason: &str) -> Result<()> {
        let score = score.clamp(0, 10);
        let reason = if reason.len() > 280 { &reason[..280] } else { reason };
        self.db.with_conn(|conn| {
            conn.execute(
                "UPDATE roast_quotes SET score = ?1, reason = ?2 WHERE id = ?3",
                rusqlite::params![score, reason, id],
            )?;
            Ok(())
        })
    }

    pub fn top(&self, limit: i64) -> Result<Vec<RoastQuote>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, user_uid, user_name, text, created_at, score, reason
                 FROM roast_quotes WHERE score IS NOT NULL
                 ORDER BY score DESC, created_at DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(rusqlite::params![limit], row_to_quote)?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
    }

    pub fn stats(&self, min_score: i64) -> Result<(u32, u32, u32)> {
        self.db.with_conn(|conn| {
            let ungraded: i64 = conn.query_row(
                "SELECT COUNT(*) FROM roast_quotes WHERE score IS NULL",
                [],
                |r| r.get(0),
            )?;
            let graded: i64 = conn.query_row(
                "SELECT COUNT(*) FROM roast_quotes WHERE score IS NOT NULL",
                [],
                |r| r.get(0),
            )?;
            let high: i64 = conn.query_row(
                "SELECT COUNT(*) FROM roast_quotes WHERE score IS NOT NULL AND score >= ?1",
                rusqlite::params![min_score],
                |r| r.get(0),
            )?;
            Ok((ungraded as u32, graded as u32, high as u32))
        })
    }

    pub fn is_opted_out(&self, user_uid: &str) -> Result<bool> {
        self.db.with_conn(|conn| {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM roast_optout WHERE user_uid = ?1",
                rusqlite::params![user_uid],
                |r| r.get(0),
            )?;
            Ok(n > 0)
        })
    }

    pub fn opt_out(&self, user_uid: &str) -> Result<u32> {
        self.db.with_conn(|conn| {
            conn.execute(
                "INSERT OR IGNORE INTO roast_optout (user_uid) VALUES (?1)",
                rusqlite::params![user_uid],
            )?;
            let n = conn.execute(
                "DELETE FROM roast_quotes WHERE user_uid = ?1",
                rusqlite::params![user_uid],
            )?;
            Ok(n as u32)
        })
    }

    pub fn opt_in(&self, user_uid: &str) -> Result<bool> {
        self.db.with_conn(|conn| {
            let n = conn.execute(
                "DELETE FROM roast_optout WHERE user_uid = ?1",
                rusqlite::params![user_uid],
            )?;
            Ok(n > 0)
        })
    }

    pub fn graded_count(&self, min_score: i64) -> Result<u32> {
        self.db.with_conn(|conn| {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM roast_quotes WHERE score IS NOT NULL AND score >= ?1",
                rusqlite::params![min_score],
                |r| r.get(0),
            )?;
            Ok(n as u32)
        })
    }

    pub fn remove_by_ids(&self, ids: &[i64]) -> Result<u32> {
        if ids.is_empty() {
            return Ok(0);
        }
        self.db.with_conn(|conn| {
            let mut n = 0u32;
            for id in ids {
                n += conn.execute("DELETE FROM roast_quotes WHERE id = ?1", rusqlite::params![id])?
                    as u32;
            }
            Ok(n)
        })
    }

    pub fn last_roast_at(&self) -> Result<i64> {
        self.db.with_conn(|conn| {
            let v: rusqlite::Result<String> = conn.query_row(
                "SELECT value FROM roast_meta WHERE key = 'last_roast_at'",
                [],
                |r| r.get(0),
            );
            Ok(v.ok().and_then(|s| s.parse().ok()).unwrap_or(0))
        })
    }

    pub fn set_last_roast_at(&self, ts: i64) -> Result<()> {
        self.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO roast_meta (key, value) VALUES ('last_roast_at', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![ts.to_string()],
            )?;
            Ok(())
        })
    }
}

fn row_to_quote(r: &rusqlite::Row<'_>) -> rusqlite::Result<RoastQuote> {
    Ok(RoastQuote {
        id: r.get(0)?,
        user_uid: r.get(1)?,
        user_name: r.get(2)?,
        text: r.get(3)?,
        created_at: r.get(4)?,
        score: r.get(5)?,
        reason: r.get(6)?,
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
    use crate::Database;

    #[test]
    fn add_grade_opt_out() {
        let db = Database::open_in_memory().unwrap();
        let s = db.roast();
        s.add("u1", "Bond", "absolutely cringe take").unwrap();
        assert_eq!(s.ungraded(10).unwrap().len(), 1);
        s.set_grade(1, 9, "yikes").unwrap();
        assert_eq!(s.top(5).unwrap()[0].score, Some(9));
        let n = s.opt_out("u1").unwrap();
        assert_eq!(n, 1);
        assert!(s.is_opted_out("u1").unwrap());
    }
}
