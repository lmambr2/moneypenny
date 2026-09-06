// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Music providers. Platforms are `local | youtube | stream` only.
//! Phase 2 implements LocalProvider (realpath+prefix), yt-dlp, HTTP streams.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Local,
    Youtube,
    Stream,
}

#[derive(Debug, Clone)]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub platform: Platform,
    pub url: String,
}

#[derive(Debug, thiserror::Error)]
pub enum MusicError {
    #[error("{0}")]
    Message(String),
    #[error("path escapes library")]
    PathGuard,
}

pub trait MusicProvider: Send + Sync {
    fn resolve(
        &self,
        input: &str,
    ) -> impl std::future::Future<Output = Result<Track, MusicError>> + Send;
}

#[cfg(test)]
mod tests {
    #[test]
    fn crate_compiles() {
        assert_eq!(env!("CARGO_PKG_NAME"), "mp-music");
    }
}
