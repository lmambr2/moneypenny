// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

#[derive(Debug, thiserror::Error)]
pub enum RagError {
    #[error("{0}")]
    Message(String),
    #[error("http: {0}")]
    Http(String),
    #[error("db: {0}")]
    Db(#[from] mp_db::DbError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, RagError>;
