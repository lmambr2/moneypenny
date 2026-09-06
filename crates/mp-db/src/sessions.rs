// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::{Database, Result, UserRole};

pub const SESSION_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
pub const SESSION_TOUCH_INTERVAL_MS: i64 = 60 * 60 * 1000;
pub const MAX_SESSIONS_PER_USER: i64 = 10;

#[derive(Debug, Clone)]
pub struct SessionValidation {
    pub user_id: String,
    pub username: String,
    pub role: UserRole,
}

pub struct SessionStore<'a> {
    pub(crate) db: &'a Database,
}

impl SessionStore<'_> {
    pub fn create_session(&self, user_id: &str) -> Result<(String, i64)> {
        let token = random_token();
        let id = hash_token(&token);
        let now = now_ms();
        let expires_at = now + SESSION_TTL_MS;
        self.db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let existing: i64 = tx.query_row(
                "SELECT COUNT(*) FROM sessions WHERE userId = ?1",
                rusqlite::params![user_id],
                |r| r.get(0),
            )?;
            if existing >= MAX_SESSIONS_PER_USER {
                tx.execute(
                    "DELETE FROM sessions WHERE id IN (
                        SELECT id FROM sessions WHERE userId = ?1 ORDER BY createdAt ASC LIMIT ?2
                    )",
                    rusqlite::params![user_id, existing - MAX_SESSIONS_PER_USER + 1],
                )?;
            }
            tx.execute(
                "INSERT INTO sessions (id, userId, createdAt, expiresAt, lastSeenAt)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![id, user_id, now, expires_at, now],
            )?;
            tx.commit()?;
            Ok(())
        })?;
        Ok((token, expires_at))
    }

    pub fn validate_and_touch(&self, raw_token: &str) -> Result<Option<SessionValidation>> {
        if raw_token.is_empty() {
            return Ok(None);
        }
        let id = hash_token(raw_token);
        self.db.with_conn(|conn| {
            let row = conn.query_row(
                "SELECT s.id, s.userId, s.expiresAt, s.lastSeenAt, u.username, u.role
                 FROM sessions s INNER JOIN users u ON u.id = s.userId
                 WHERE s.id = ?1",
                rusqlite::params![id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                    ))
                },
            );
            let (sid, user_id, expires_at, last_seen, username, role) = match row {
                Ok(v) => v,
                Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
                Err(e) => return Err(e.into()),
            };
            let now = now_ms();
            if expires_at < now {
                conn.execute("DELETE FROM sessions WHERE id = ?1", rusqlite::params![sid])?;
                return Ok(None);
            }
            if now - last_seen > SESSION_TOUCH_INTERVAL_MS {
                conn.execute(
                    "UPDATE sessions SET lastSeenAt = ?1, expiresAt = ?2 WHERE id = ?3",
                    rusqlite::params![now, now + SESSION_TTL_MS, sid],
                )?;
            }
            Ok(Some(SessionValidation {
                user_id,
                username,
                role: UserRole::parse(&role),
            }))
        })
    }

    pub fn delete_session(&self, raw_token: &str) -> Result<()> {
        let id = hash_token(raw_token);
        self.db.with_conn(|conn| {
            conn.execute("DELETE FROM sessions WHERE id = ?1", rusqlite::params![id])?;
            Ok(())
        })
    }

    pub fn delete_all_for_user(&self, user_id: &str, except_token: Option<&str>) -> Result<()> {
        self.db.with_conn(|conn| {
            if let Some(tok) = except_token {
                let except = hash_token(tok);
                conn.execute(
                    "DELETE FROM sessions WHERE userId = ?1 AND id != ?2",
                    rusqlite::params![user_id, except],
                )?;
            } else {
                conn.execute(
                    "DELETE FROM sessions WHERE userId = ?1",
                    rusqlite::params![user_id],
                )?;
            }
            Ok(())
        })
    }
}

fn hash_token(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    hex::encode(h.finalize())
}

fn random_token() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    URL_SAFE_NO_PAD.encode(buf)
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
    fn session_roundtrip() {
        let db = Database::open_in_memory().unwrap();
        let user = db
            .users()
            .create_first_user("admin", "password12")
            .unwrap()
            .unwrap();
        let (token, _) = db.sessions().create_session(&user.id).unwrap();
        let v = db.sessions().validate_and_touch(&token).unwrap().unwrap();
        assert_eq!(v.username, "admin");
        assert_eq!(v.role, UserRole::Admin);
        db.sessions().delete_session(&token).unwrap();
        assert!(db.sessions().validate_and_touch(&token).unwrap().is_none());
    }
}
