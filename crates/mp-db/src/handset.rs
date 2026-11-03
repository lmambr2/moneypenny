// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Handset devices and one-time pair codes (PR 1 of the pocket client).
//! The bearer is `mpd_` plus 32 random bytes. Only the SHA-256 hex is stored.
//! Devices have no expiry. Pair codes last five minutes and redeem once.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use uuid::Uuid;

use crate::token_hash::token_sha256_hex;
use crate::{Database, DbError, Result};

pub const HANDSET_TOKEN_PREFIX: &str = "mpd_";
pub const HANDSET_TOUCH_INTERVAL_MS: i64 = 60_000;
pub const HANDSET_PAIR_TTL_MS: i64 = 5 * 60 * 1000;
pub const MAX_HANDSET_DEVICES: i64 = 8;

pub const HANDSET_SQL: &str = "
CREATE TABLE IF NOT EXISTS handset_devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_handset_devices_revoked ON handset_devices(revoked_at);
CREATE TABLE IF NOT EXISTS handset_pair_codes (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
";

const PAIR_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandsetDevice {
    pub id: String,
    pub label: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub revoked_at: Option<i64>,
}

pub struct HandsetStore<'a> {
    pub(crate) db: &'a Database,
}

impl HandsetStore<'_> {
    pub fn mint_device(&self, label: &str) -> Result<(String, HandsetDevice)> {
        self.mint_device_at(label, now_ms())
    }

    pub fn mint_device_at(&self, label: &str, now: i64) -> Result<(String, HandsetDevice)> {
        let token = random_device_token();
        let device = self.insert_device(&token, label, now)?;
        Ok((token, device))
    }

    pub fn validate_and_touch(&self, raw_token: &str) -> Result<Option<HandsetDevice>> {
        self.validate_and_touch_at(raw_token, now_ms())
    }

    /// Missing, revoked, or not an `mpd_` bearer is `None`. A hit updates
    /// `last_seen_at` at most once a minute and does not extend any expiry.
    pub fn validate_and_touch_at(
        &self,
        raw_token: &str,
        now: i64,
    ) -> Result<Option<HandsetDevice>> {
        if !raw_token.starts_with(HANDSET_TOKEN_PREFIX) {
            return Ok(None);
        }
        let hash = token_sha256_hex(raw_token);
        self.db.with_conn(|conn| {
            let row = conn.query_row(
                "SELECT id, label, created_at, last_seen_at, revoked_at
                 FROM handset_devices WHERE token_hash = ?1",
                rusqlite::params![hash],
                read_device,
            );
            let mut device = match row {
                Ok(v) => v,
                Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
                Err(e) => return Err(e.into()),
            };
            if device.revoked_at.is_some() {
                return Ok(None);
            }
            if now.saturating_sub(device.last_seen_at) > HANDSET_TOUCH_INTERVAL_MS {
                conn.execute(
                    "UPDATE handset_devices SET last_seen_at = ?1 WHERE id = ?2",
                    rusqlite::params![now, device.id],
                )?;
                device.last_seen_at = now;
            }
            Ok(Some(device))
        })
    }

    pub fn revoke(&self, device_id: &str) -> Result<bool> {
        self.revoke_at(device_id, now_ms())
    }

    pub fn revoke_at(&self, device_id: &str, now: i64) -> Result<bool> {
        self.db.with_conn(|conn| {
            let n = conn.execute(
                "UPDATE handset_devices SET revoked_at = ?1
                 WHERE id = ?2 AND revoked_at IS NULL",
                rusqlite::params![now, device_id],
            )?;
            Ok(n == 1)
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<HandsetDevice>> {
        self.db.with_conn(|conn| {
            match conn.query_row(
                "SELECT id, label, created_at, last_seen_at, revoked_at
                 FROM handset_devices WHERE id = ?1",
                rusqlite::params![id],
                read_device,
            ) {
                Ok(device) => Ok(Some(device)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.into()),
            }
        })
    }

    pub fn list(&self) -> Result<Vec<HandsetDevice>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, label, created_at, last_seen_at, revoked_at
                 FROM handset_devices ORDER BY created_at ASC",
            )?;
            let rows = stmt
                .query_map([], read_device)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn mint_pair_code(&self) -> Result<(String, i64)> {
        self.mint_pair_code_at(now_ms())
    }

    pub fn mint_pair_code_at(&self, now: i64) -> Result<(String, i64)> {
        let code = random_pair_code();
        let hash = token_sha256_hex(&normalize_pair_code(&code));
        let expires_at = now + HANDSET_PAIR_TTL_MS;
        self.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO handset_pair_codes (code_hash, created_at, expires_at, consumed_at)
                 VALUES (?1, ?2, ?3, NULL)",
                rusqlite::params![hash, now, expires_at],
            )?;
            Ok(())
        })?;
        Ok((code, expires_at))
    }

    /// `Ok(None)` is an unknown, expired, or already used code.
    /// The device cap is an error and leaves the code unused.
    pub fn consume_pair_code(
        &self,
        raw_code: &str,
        label: &str,
    ) -> Result<Option<(String, HandsetDevice)>> {
        self.consume_pair_code_at(raw_code, label, now_ms())
    }

    pub fn consume_pair_code_at(
        &self,
        raw_code: &str,
        label: &str,
        now: i64,
    ) -> Result<Option<(String, HandsetDevice)>> {
        let normalized = normalize_pair_code(raw_code);
        if normalized.is_empty() {
            return Ok(None);
        }
        let hash = token_sha256_hex(&normalized);
        let token = random_device_token();
        let token_hash = token_sha256_hex(&token);
        let label = clip_label(label);
        let id = Uuid::new_v4().to_string();
        self.db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let row = tx.query_row(
                "SELECT expires_at, consumed_at FROM handset_pair_codes WHERE code_hash = ?1",
                rusqlite::params![hash],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?)),
            );
            let (expires_at, consumed_at) = match row {
                Ok(v) => v,
                Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
                Err(e) => return Err(e.into()),
            };
            if consumed_at.is_some() || expires_at <= now {
                return Ok(None);
            }
            let active = active_count(&tx)?;
            if active >= MAX_HANDSET_DEVICES {
                return Err(DbError::Message("handset device cap reached".into()));
            }
            tx.execute(
                "INSERT INTO handset_devices
                    (id, token_hash, label, created_at, last_seen_at, revoked_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
                rusqlite::params![id, token_hash, label, now, now],
            )?;
            tx.execute(
                "UPDATE handset_pair_codes SET consumed_at = ?1 WHERE code_hash = ?2",
                rusqlite::params![now, hash],
            )?;
            tx.commit()?;
            Ok(Some((
                token,
                HandsetDevice {
                    id,
                    label,
                    created_at: now,
                    last_seen_at: now,
                    revoked_at: None,
                },
            )))
        })
    }

    fn insert_device(&self, token: &str, label: &str, now: i64) -> Result<HandsetDevice> {
        let token_hash = token_sha256_hex(token);
        let label = clip_label(label);
        let id = Uuid::new_v4().to_string();
        self.db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let active = active_count(&tx)?;
            if active >= MAX_HANDSET_DEVICES {
                return Err(DbError::Message("handset device cap reached".into()));
            }
            tx.execute(
                "INSERT INTO handset_devices
                    (id, token_hash, label, created_at, last_seen_at, revoked_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
                rusqlite::params![id, token_hash, label, now, now],
            )?;
            tx.commit()?;
            Ok(HandsetDevice {
                id,
                label,
                created_at: now,
                last_seen_at: now,
                revoked_at: None,
            })
        })
    }
}

fn read_device(row: &rusqlite::Row<'_>) -> rusqlite::Result<HandsetDevice> {
    Ok(HandsetDevice {
        id: row.get(0)?,
        label: row.get(1)?,
        created_at: row.get(2)?,
        last_seen_at: row.get(3)?,
        revoked_at: row.get(4)?,
    })
}

fn active_count(conn: &rusqlite::Connection) -> Result<i64> {
    let n = conn.query_row(
        "SELECT COUNT(*) FROM handset_devices WHERE revoked_at IS NULL",
        [],
        |r| r.get(0),
    )?;
    Ok(n)
}

fn clip_label(label: &str) -> String {
    let trimmed = label.trim();
    let raw = if trimmed.is_empty() {
        "Handset"
    } else {
        trimmed
    };
    raw.chars().take(64).collect()
}

pub fn normalize_pair_code(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn random_device_token() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    format!("{HANDSET_TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(buf))
}

fn random_pair_code() -> String {
    let mut buf = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter()
        .map(|b| PAIR_ALPHABET[(*b as usize) % PAIR_ALPHABET.len()] as char)
        .collect()
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

    #[test]
    fn revoked_token_does_not_validate() {
        let db = Database::open_in_memory().unwrap();
        let (token, device) = db.handsets().mint_device_at("pocket", 1_000).unwrap();
        assert!(token.starts_with("mpd_"));
        let seen = db
            .handsets()
            .validate_and_touch_at(&token, 1_000)
            .unwrap()
            .unwrap();
        assert_eq!(seen.id, device.id);
        assert_eq!(seen.last_seen_at, 1_000);
        let later = db
            .handsets()
            .validate_and_touch_at(&token, 1_000 + HANDSET_TOUCH_INTERVAL_MS)
            .unwrap()
            .unwrap();
        assert_eq!(later.last_seen_at, 1_000);
        let touched = db
            .handsets()
            .validate_and_touch_at(&token, 1_001 + HANDSET_TOUCH_INTERVAL_MS)
            .unwrap()
            .unwrap();
        assert_eq!(touched.last_seen_at, 1_001 + HANDSET_TOUCH_INTERVAL_MS);
        assert!(db.handsets().revoke_at(&device.id, 9_000).unwrap());
        assert!(
            db.handsets()
                .validate_and_touch_at(&token, 9_001)
                .unwrap()
                .is_none()
        );
        assert!(!db.handsets().revoke_at(&device.id, 9_002).unwrap());
    }

    #[test]
    fn eighth_device_is_the_cap() {
        let db = Database::open_in_memory().unwrap();
        let mut ids = Vec::new();
        for i in 0..MAX_HANDSET_DEVICES {
            let (_, device) = db.handsets().mint_device_at(&format!("d{i}"), i).unwrap();
            ids.push(device.id);
        }
        let err = db.handsets().mint_device_at("over", 99).unwrap_err();
        assert!(err.to_string().contains("cap"));
        db.handsets().revoke_at(&ids[0], 100).unwrap();
        assert!(db.handsets().mint_device_at("after-revoke", 101).is_ok());
    }

    #[test]
    fn pair_code_is_single_use_and_case_insensitive() {
        let db = Database::open_in_memory().unwrap();
        let (code, expires) = db.handsets().mint_pair_code_at(1_000).unwrap();
        assert_eq!(expires, 1_000 + HANDSET_PAIR_TTL_MS);
        let dashed = format!(
            "{}-{}",
            code[..4].to_ascii_lowercase(),
            code[4..].to_ascii_lowercase()
        );
        let (token, device) = db
            .handsets()
            .consume_pair_code_at(&dashed, "  phone  ", 1_000)
            .unwrap()
            .unwrap();
        assert_eq!(device.label, "phone");
        assert!(
            db.handsets()
                .validate_and_touch_at(&token, 1_000)
                .unwrap()
                .is_some()
        );
        assert!(
            db.handsets()
                .consume_pair_code_at(&code, "again", 1_001)
                .unwrap()
                .is_none()
        );
        let (fresh, _) = db.handsets().mint_pair_code_at(2_000).unwrap();
        assert!(
            db.handsets()
                .consume_pair_code_at(&fresh, "late", 2_000 + HANDSET_PAIR_TTL_MS)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn pair_code_at_the_cap_stays_unused() {
        let db = Database::open_in_memory().unwrap();
        for i in 0..MAX_HANDSET_DEVICES {
            db.handsets().mint_device_at("full", i).unwrap();
        }
        let (code, _) = db.handsets().mint_pair_code_at(50).unwrap();
        let err = db
            .handsets()
            .consume_pair_code_at(&code, "nope", 50)
            .unwrap_err();
        assert!(err.to_string().contains("cap"));
        db.handsets()
            .revoke_at(&db.handsets().list().unwrap()[0].id, 51)
            .unwrap();
        assert!(
            db.handsets()
                .consume_pair_code_at(&code, "ok", 52)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn session_tokens_use_the_same_hash() {
        let db = Database::open_in_memory().unwrap();
        let user = db
            .users()
            .create_first_user("admin", "password12")
            .unwrap()
            .unwrap();
        let (token, _) = db.sessions().create_session(&user.id).unwrap();
        let hash = token_sha256_hex(&token);
        let stored: String = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT id FROM sessions WHERE id = ?1",
                    rusqlite::params![hash],
                    |r| r.get(0),
                )
                .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(stored, hash);
    }
}
