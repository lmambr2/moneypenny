// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! `user_audit` — same columns as Node `bot/src/data/audit.ts`.

use serde::Serialize;

use crate::{Database, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: i64,
    pub timestamp: i64,
    pub actor_id: Option<String>,
    pub actor_username: Option<String>,
    pub target_user_id: Option<String>,
    pub target_username: Option<String>,
    pub action: String,
}

pub struct AuditStore<'a> {
    pub(crate) db: &'a Database,
}

impl AuditStore<'_> {
    pub fn record(
        &self,
        actor_id: Option<&str>,
        actor_username: Option<&str>,
        target_user_id: Option<&str>,
        target_username: Option<&str>,
        action: &str,
    ) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let _ = self.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO user_audit (timestamp, actorId, actorUsername, targetUserId, targetUsername, action)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    ts,
                    actor_id,
                    actor_username,
                    target_user_id,
                    target_username,
                    action
                ],
            )?;
            Ok(())
        });
    }

    pub fn list(&self, limit: u32, offset: u32) -> Result<Vec<AuditEntry>> {
        let limit = limit.clamp(1, 500);
        let offset = offset.min(100_000);
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, timestamp, actorId, actorUsername, targetUserId, targetUsername, action
                 FROM user_audit ORDER BY timestamp DESC, id DESC LIMIT ?1 OFFSET ?2",
            )?;
            let rows = stmt.query_map(rusqlite::params![limit, offset], |row| {
                Ok(AuditEntry {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    actor_id: row.get(2)?,
                    actor_username: row.get(3)?,
                    target_user_id: row.get(4)?,
                    target_username: row.get(5)?,
                    action: row.get(6)?,
                })
            })?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::Database;

    #[test]
    fn record_and_list() {
        let db = Database::open_in_memory().unwrap();
        db.audit().record(
            Some("u1"),
            Some("admin"),
            None,
            Some("music_play"),
            "mcp.tool",
        );
        let rows = db.audit().list(10, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].action, "mcp.tool");
        assert_eq!(rows[0].actor_username.as_deref(), Some("admin"));
    }
}
