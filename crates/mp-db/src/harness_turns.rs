// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! SQLite `harness_turns` (PR-H2). The in-memory ring stays the dashboard.
//! `user_text` is user ASR or typed text, never Talker 0x02. PCM is not stored.

use crate::{Database, Result};

pub const HARNESS_TURN_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

pub const HARNESS_TURNS_SQL: &str = "
CREATE TABLE IF NOT EXISTS harness_turns (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  channel TEXT NOT NULL,
  conversation_id TEXT,
  user_uid TEXT,
  mode TEXT NOT NULL,
  user_text TEXT NOT NULL,
  reply_text TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  error TEXT,
  steps INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_harness_turns_at ON harness_turns(at);
";

#[derive(Debug, Clone)]
pub struct HarnessTurnRow {
    pub id: String,
    pub at: i64,
    pub channel: String,
    pub conversation_id: Option<String>,
    pub user_uid: Option<String>,
    pub mode: String,
    pub user_text: String,
    pub reply_text: String,
    pub tools_json: String,
    pub sources_json: String,
    pub error: Option<String>,
    pub steps: i64,
}

impl Database {
    pub fn insert_harness_turn(&self, row: &HarnessTurnRow) -> Result<()> {
        self.insert_harness_turn_at(row, row.at)
    }

    pub fn insert_harness_turn_at(&self, row: &HarnessTurnRow, now_ms: i64) -> Result<()> {
        self.with_conn(|conn| {
            conn.execute_batch(HARNESS_TURNS_SQL)?;
            conn.execute(
                "DELETE FROM harness_turns WHERE at < ?1",
                rusqlite::params![now_ms - HARNESS_TURN_RETENTION_MS],
            )?;
            conn.execute(
                "INSERT OR REPLACE INTO harness_turns (
                    id, at, channel, conversation_id, user_uid, mode,
                    user_text, reply_text, tools_json, sources_json, error, steps
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                rusqlite::params![
                    row.id,
                    row.at,
                    row.channel,
                    row.conversation_id,
                    row.user_uid,
                    row.mode,
                    row.user_text,
                    row.reply_text,
                    row.tools_json,
                    row.sources_json,
                    row.error,
                    row.steps,
                ],
            )?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prunes_rows_older_than_thirty_days() {
        let db = Database::open_in_memory().unwrap();
        let old = HarnessTurnRow {
            id: "old".into(),
            at: 1,
            channel: "dashboard".into(),
            conversation_id: None,
            user_uid: Some("web:1".into()),
            mode: "ask".into(),
            user_text: "old".into(),
            reply_text: "".into(),
            tools_json: "[]".into(),
            sources_json: "[]".into(),
            error: None,
            steps: 1,
        };
        db.insert_harness_turn_at(&old, 1).unwrap();
        let now = HARNESS_TURN_RETENTION_MS + 10;
        let fresh = HarnessTurnRow {
            id: "new".into(),
            at: now,
            user_text: "play ambient".into(),
            user_uid: Some("web:9".into()),
            steps: 2,
            ..old
        };
        db.insert_harness_turn_at(&fresh, now).unwrap();
        let n: i64 = db
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM harness_turns", [], |r| r.get(0))
                    .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(n, 1);
        let kept: String = db
            .with_conn(|c| {
                c.query_row("SELECT user_text FROM harness_turns", [], |r| r.get(0))
                    .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(kept, "play ambient");
    }
}
