// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use uuid::Uuid;

use crate::{Database, DbError, Result};

pub const BCRYPT_COST: u32 = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserRole {
    Admin,
    Member,
}

impl UserRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Member => "member",
        }
    }

    pub fn parse(s: &str) -> Self {
        if s.eq_ignore_ascii_case("member") {
            Self::Member
        } else {
            Self::Admin
        }
    }
}

#[derive(Debug, Clone)]
pub struct UserRow {
    pub id: String,
    pub username: String,
    pub password_hash: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub role: UserRole,
}

#[derive(Debug, thiserror::Error)]
#[error("username taken: {0}")]
pub struct UsernameTakenError(pub String);

pub struct UserStore<'a> {
    pub(crate) db: &'a Database,
}

impl UserStore<'_> {
    pub fn count_users(&self) -> Result<u32> {
        self.db.user_count()
    }

    pub fn create_first_user(&self, username: &str, password: &str) -> Result<Option<UserRow>> {
        let hash = hash_password(password)?;
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        self.db.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let n: i64 = tx.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
            if n != 0 {
                return Ok(None);
            }
            let res = tx.execute(
                "INSERT INTO users (id, username, passwordHash, createdAt, updatedAt, role)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'admin')",
                rusqlite::params![id, username, hash, now, now],
            );
            match res {
                Ok(_) => {
                    tx.commit()?;
                    Ok(Some(UserRow {
                        id,
                        username: username.to_string(),
                        password_hash: hash,
                        created_at: now,
                        updated_at: now,
                        role: UserRole::Admin,
                    }))
                }
                Err(rusqlite::Error::SqliteFailure(e, _))
                    if e.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    Ok(None)
                }
                Err(e) => Err(e.into()),
            }
        })
    }

    pub fn find_by_username(&self, username: &str) -> Result<Option<UserRow>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, username, passwordHash, createdAt, updatedAt, role
                 FROM users WHERE username = ?1 COLLATE NOCASE",
            )?;
            let mut rows = stmt.query(rusqlite::params![username])?;
            match rows.next()? {
                Some(row) => Ok(Some(row_from(row)?)),
                None => Ok(None),
            }
        })
    }

    pub fn list_users(&self) -> Result<Vec<UserRow>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, username, passwordHash, createdAt, updatedAt, role
                 FROM users ORDER BY createdAt ASC",
            )?;
            let rows = stmt.query_map([], row_from)?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
    }

    pub fn find_by_id(&self, id: &str) -> Result<Option<UserRow>> {
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, username, passwordHash, createdAt, updatedAt, role
                 FROM users WHERE id = ?1",
            )?;
            let mut rows = stmt.query(rusqlite::params![id])?;
            match rows.next()? {
                Some(row) => Ok(Some(row_from(row)?)),
                None => Ok(None),
            }
        })
    }

    pub fn verify_password(&self, plain: &str, hash: &str) -> Result<bool> {
        bcrypt::verify(plain, hash).map_err(|e| DbError::Message(e.to_string()))
    }

    pub fn change_password(&self, user_id: &str, new_password: &str) -> Result<()> {
        let hash = hash_password(new_password)?;
        let now = now_ms();
        self.db.with_conn(|conn| {
            conn.execute(
                "UPDATE users SET passwordHash = ?1, updatedAt = ?2 WHERE id = ?3",
                rusqlite::params![hash, now, user_id],
            )?;
            Ok(())
        })
    }

    pub fn create_user(
        &self,
        username: &str,
        password: &str,
        role: UserRole,
    ) -> Result<UserRow> {
        let hash = hash_password(password)?;
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        let role_s = role.as_str();
        self.db.with_conn(|conn| {
            match conn.execute(
                "INSERT INTO users (id, username, passwordHash, createdAt, updatedAt, role)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![id, username, hash, now, now, role_s],
            ) {
                Ok(_) => Ok(UserRow {
                    id,
                    username: username.to_string(),
                    password_hash: hash,
                    created_at: now,
                    updated_at: now,
                    role,
                }),
                Err(rusqlite::Error::SqliteFailure(e, _))
                    if e.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    Err(DbError::Message(format!("username taken: {username}")))
                }
                Err(e) => Err(e.into()),
            }
        })
    }

    pub fn count_admins(&self) -> Result<u32> {
        self.db.with_conn(|conn| {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM users WHERE role = 'admin'",
                [],
                |r| r.get(0),
            )?;
            Ok(n as u32)
        })
    }

    pub fn set_role_if_not_last_admin(
        &self,
        id: &str,
        new_role: UserRole,
    ) -> Result<&'static str> {
        let Some(row) = self.find_by_id(id)? else {
            return Ok("not_found");
        };
        if row.role == new_role {
            return Ok("ok");
        }
        if row.role == UserRole::Admin && new_role == UserRole::Member {
            if self.count_admins()? <= 1 {
                return Ok("would_orphan");
            }
        }
        let now = now_ms();
        self.db.with_conn(|conn| {
            conn.execute(
                "UPDATE users SET role = ?1, updatedAt = ?2 WHERE id = ?3",
                rusqlite::params![new_role.as_str(), now, id],
            )?;
            Ok(())
        })?;
        Ok("ok")
    }

    pub fn delete_if_not_last_admin(&self, id: &str) -> Result<&'static str> {
        let Some(row) = self.find_by_id(id)? else {
            return Ok("not_found");
        };
        if row.role == UserRole::Admin && self.count_admins()? <= 1 {
            return Ok("would_orphan");
        }
        self.db.with_conn(|conn| {
            conn.execute("DELETE FROM users WHERE id = ?1", rusqlite::params![id])?;
            Ok(())
        })?;
        Ok("ok")
    }
}

fn row_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserRow> {
    let role: String = row.get(5)?;
    Ok(UserRow {
        id: row.get(0)?,
        username: row.get(1)?,
        password_hash: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        role: UserRole::parse(&role),
    })
}

fn hash_password(password: &str) -> Result<String> {
    bcrypt::hash(password, BCRYPT_COST).map_err(|e| DbError::Message(e.to_string()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
