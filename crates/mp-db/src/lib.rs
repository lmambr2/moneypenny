// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! SQLite access for `moneypenny.db`. Same tables as Node `better-sqlite3`.
//!
//! Dual-run rule: this crate applies `CREATE TABLE IF NOT EXISTS` only.
//! Idempotent `ALTER TABLE ... ADD COLUMN` matches Node `migrateSchema`.
//! Do not invent new columns here.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OpenFlags};

mod audit;
mod history;
mod memory;
mod roast;
mod sessions;
mod users;
mod work_orders;
mod yt_saved;

pub use audit::{AuditEntry, AuditStore};
pub use history::PlayHistoryStore;
pub use memory::{MemoryFact, MemoryStore};
pub use roast::{RoastQuote, RoastStore};
pub use sessions::{SessionStore, SessionValidation, MAX_SESSIONS_PER_USER, SESSION_TTL_MS};
pub use users::{UserRole, UserRow, UserStore, UsernameTakenError, BCRYPT_COST};
pub use work_orders::{aggregate, WorkOrder, WorkOrderLine, WorkOrderStore};
pub use yt_saved::YtSavedStore;

pub const SCHEMA_SQL: &str = include_str!("schema.sql");

/// Tables Node creates. Used as the Phase 0 read-only assertion list.
pub const EXPECTED_TABLES: &[&str] = &[
    "play_history",
    "bot_instances",
    "users",
    "sessions",
    "user_audit",
    "user_memory",
    "kg_facts",
    "doctrine_docs",
    "ingested_files",
    "track_tags",
    "track_ratings",
    "yt_saved",
    "hangar_profiles",
    "user_ships",
    "bumper_cache",
    "work_orders",
    "playback_blacklist",
    "economy_cache",
    "roast_quotes",
    "roast_optout",
    "roast_meta",
];

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Message(String),
}

pub type Result<T> = std::result::Result<T, DbError>;

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA_SQL)?;
        migrate_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Open existing DB without applying DDL (Phase 0 contract freeze / dual-run read).
    pub fn open_read_only(path: &Path) -> Result<Self> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(SCHEMA_SQL)?;
        migrate_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        f(&guard)
    }

    pub fn table_names(&self) -> Result<Vec<String>> {
        self.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )?;
            let names = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(names)
        })
    }

    /// Assert every Node table exists. Extra tables are allowed (future Node).
    pub fn assert_expected_tables(&self) -> Result<()> {
        let have: std::collections::HashSet<String> = self.table_names()?.into_iter().collect();
        let missing: Vec<&str> = EXPECTED_TABLES
            .iter()
            .copied()
            .filter(|t| !have.contains(*t))
            .collect();
        if !missing.is_empty() {
            return Err(DbError::Message(format!(
                "moneypenny.db missing tables: {}",
                missing.join(", ")
            )));
        }
        Ok(())
    }

    pub fn users(&self) -> UserStore<'_> {
        UserStore { db: self }
    }

    pub fn audit(&self) -> AuditStore<'_> {
        AuditStore { db: self }
    }

    pub fn sessions(&self) -> SessionStore<'_> {
        SessionStore { db: self }
    }

    pub fn play_history(&self) -> PlayHistoryStore<'_> {
        PlayHistoryStore { db: self }
    }

    pub fn memory(&self) -> MemoryStore<'_> {
        MemoryStore { db: self }
    }

    pub fn roast(&self) -> RoastStore<'_> {
        RoastStore { db: self }
    }

    pub fn work_orders(&self) -> WorkOrderStore<'_> {
        WorkOrderStore { db: self }
    }

    pub fn yt_saved(&self) -> YtSavedStore<'_> {
        YtSavedStore { db: self }
    }

    pub fn user_count(&self) -> Result<u32> {
        self.with_conn(|conn| {
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
            Ok(n as u32)
        })
    }
}

fn migrate_schema(conn: &Connection) -> Result<()> {
    let cols = table_columns(conn, "bot_instances")?;
    add_col(
        conn,
        &cols,
        "bot_instances",
        "identity",
        "ALTER TABLE bot_instances ADD COLUMN identity TEXT",
    )?;
    add_col(
        conn,
        &cols,
        "bot_instances",
        "serverProtocol",
        "ALTER TABLE bot_instances ADD COLUMN serverProtocol TEXT NOT NULL DEFAULT ''",
    )?;
    add_col(
        conn,
        &cols,
        "bot_instances",
        "ts6ApiKey",
        "ALTER TABLE bot_instances ADD COLUMN ts6ApiKey TEXT NOT NULL DEFAULT ''",
    )?;
    add_col(
        conn,
        &cols,
        "bot_instances",
        "serverPassword",
        "ALTER TABLE bot_instances ADD COLUMN serverPassword TEXT NOT NULL DEFAULT ''",
    )?;
    for col in [
        "profile_avatar_enabled",
        "profile_description_enabled",
        "profile_nickname_enabled",
        "profile_away_enabled",
        "profile_channel_desc_enabled",
        "profile_now_playing_enabled",
    ] {
        add_col(
            conn,
            &cols,
            "bot_instances",
            col,
            &format!("ALTER TABLE bot_instances ADD COLUMN {col} INTEGER NOT NULL DEFAULT 1"),
        )?;
    }
    add_col(
        conn,
        &cols,
        "bot_instances",
        "custom_avatar_path",
        "ALTER TABLE bot_instances ADD COLUMN custom_avatar_path TEXT",
    )?;

    let user_cols = table_columns(conn, "users")?;
    add_col(
        conn,
        &user_cols,
        "users",
        "role",
        "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'",
    )?;

    let doctrine_cols = table_columns(conn, "doctrine_docs")?;
    add_col(
        conn,
        &doctrine_cols,
        "doctrine_docs",
        "valid_until",
        "ALTER TABLE doctrine_docs ADD COLUMN valid_until TEXT",
    )?;
    Ok(())
}

fn table_columns(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(cols)
}

fn add_col(
    conn: &Connection,
    existing: &[String],
    _table: &str,
    col: &str,
    sql: &str,
) -> Result<()> {
    if !existing.iter().any(|c| c == col) {
        conn.execute_batch(sql)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_creates_every_known_table() {
        let db = Database::open_in_memory().unwrap();
        db.assert_expected_tables().unwrap();
        let names = db.table_names().unwrap();
        assert!(names.contains(&"users".into()));
        assert!(names.contains(&"sessions".into()));
        assert_eq!(db.user_count().unwrap(), 0);
    }

    #[test]
    fn first_user_is_admin() {
        let db = Database::open_in_memory().unwrap();
        let user = db
            .users()
            .create_first_user("lane", "password12")
            .unwrap()
            .unwrap();
        assert_eq!(user.role, UserRole::Admin);
        assert!(db.users().create_first_user("other", "password12").unwrap().is_none());
        assert!(db.users().verify_password("password12", &user.password_hash).unwrap());
    }
}
