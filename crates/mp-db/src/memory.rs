// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use crate::{Database, Result};

#[derive(Debug, Clone)]
pub struct MemoryFact {
    pub id: i64,
    pub user_uid: String,
    pub fact: String,
    pub created_at: i64,
}

pub struct MemoryStore<'a> {
    pub(crate) db: &'a Database,
}

impl MemoryStore<'_> {
    pub fn add(&self, user_uid: &str, fact: &str) -> Result<()> {
        let fact = if fact.len() > 500 { &fact[..500] } else { fact };
        let now = now_ms();
        self.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO user_memory (user_uid, fact, created_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![user_uid, fact, now],
            )?;
            Ok(())
        })
    }

    pub fn recall(&self, user_uid: &str, limit: i64) -> Result<Vec<MemoryFact>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, user_uid, fact, created_at FROM user_memory
                 WHERE user_uid = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(rusqlite::params![user_uid, limit], row_to_fact)?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
    }

    pub fn count(&self, user_uid: &str) -> Result<u32> {
        self.db.with_conn(|conn| {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM user_memory WHERE user_uid = ?1",
                rusqlite::params![user_uid],
                |r| r.get(0),
            )?;
            Ok(n as u32)
        })
    }

    pub fn forget(&self, user_uid: &str) -> Result<u32> {
        self.db.with_conn(|conn| {
            let n = conn.execute(
                "DELETE FROM user_memory WHERE user_uid = ?1",
                rusqlite::params![user_uid],
            )?;
            Ok(n as u32)
        })
    }

    pub fn forget_one(&self, user_uid: &str, id: i64) -> Result<bool> {
        self.db.with_conn(|conn| {
            let n = conn.execute(
                "DELETE FROM user_memory WHERE id = ?1 AND user_uid = ?2",
                rusqlite::params![id, user_uid],
            )?;
            Ok(n > 0)
        })
    }

    pub fn forget_at_index(&self, user_uid: &str, index: i64) -> Result<bool> {
        if index < 1 {
            return Ok(false);
        }
        let facts = self.recall(user_uid, 100)?;
        let Some(fact) = facts.get((index - 1) as usize) else {
            return Ok(false);
        };
        self.forget_one(user_uid, fact.id)
    }
}

fn row_to_fact(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryFact> {
    Ok(MemoryFact {
        id: row.get(0)?,
        user_uid: row.get(1)?,
        fact: row.get(2)?,
        created_at: row.get(3)?,
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
    fn store_recall_forget() {
        let db = Database::open_in_memory().unwrap();
        let st = db.memory();
        st.add("uid-a", "flies a Gladius").unwrap();
        st.add("uid-a", "prefers night ops").unwrap();
        st.add("uid-b", "logistics lead").unwrap();
        let a = st.recall("uid-a", 20).unwrap();
        assert_eq!(
            a.iter().map(|f| f.fact.as_str()).collect::<Vec<_>>(),
            ["prefers night ops", "flies a Gladius"]
        );
        assert_eq!(st.count("uid-a").unwrap(), 2);
        assert_eq!(st.forget("uid-a").unwrap(), 2);
        assert!(st.recall("uid-a", 20).unwrap().is_empty());
        assert_eq!(st.count("uid-b").unwrap(), 1);
    }

    #[test]
    fn forget_one_scoped() {
        let db = Database::open_in_memory().unwrap();
        let st = db.memory();
        st.add("uid-a", "keep").unwrap();
        st.add("uid-a", "drop").unwrap();
        let drop = &st.recall("uid-a", 20).unwrap()[0];
        assert!(!st.forget_one("uid-b", drop.id).unwrap());
        assert!(st.forget_one("uid-a", drop.id).unwrap());
        assert_eq!(
            st.recall("uid-a", 20)
                .unwrap()
                .iter()
                .map(|f| f.fact.as_str())
                .collect::<Vec<_>>(),
            ["keep"]
        );
    }
}
