// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Runtime config: `data/config.json` + env overlays.
//!
//! Defaults match `bot/src/data/config.ts` `getDefaultConfig()` at ec464a2.
//! Phase 0/1 is load-only — do not write config.json (Node owns DDL/writes
//! during dual-run).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("failed to read config {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid config JSON: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, ConfigError>;

pub const SESSION_COOKIE_NAME: &str = "moneypenny_session";
pub const BCRYPT_COST: u32 = 12;
pub const DEFAULT_BIND: &str = "127.0.0.1";
pub const DEFAULT_WEB_PORT: u16 = 3000;

/// Station default genre blocklist (`music/genre-block.ts`).
pub const DEFAULT_MUSIC_BLOCKED_GENRES: &[&str] = &[
    "rap",
    "hip hop",
    "hip-hop",
    "hiphop",
    "r&b",
    "rnb",
    "r and b",
    "rhythm and blues",
];

/// Subset of `BotConfig` needed to boot HTTP + later crates.
/// Unknown JSON keys are ignored (we do not round-trip-save in Phase 0/1).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotConfig {
    #[serde(default = "default_web_port")]
    pub web_port: u16,
    #[serde(default = "default_bind")]
    pub bind_address: String,
    #[serde(default = "default_locale")]
    pub locale: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_prefix")]
    pub command_prefix: String,
    #[serde(default)]
    pub public_url: String,
    #[serde(default)]
    pub trust_proxy: bool,
    #[serde(default = "default_trust_proxy_hops")]
    pub trust_proxy_hops: u32,
    #[serde(default)]
    pub llm_enabled: bool,
    #[serde(default)]
    pub llm_url: String,
    #[serde(default)]
    pub llm_model: String,
    #[serde(default)]
    pub llm_fallback_url: String,
    #[serde(default)]
    pub llm_fallback_model: String,
    #[serde(default)]
    pub embedding_url: String,
    #[serde(default)]
    pub embedding_model: String,
    #[serde(default)]
    pub rights_enabled: bool,
    #[serde(default = "default_true")]
    pub poke_commands_enabled: bool,
    #[serde(default = "default_music_opus")]
    pub music_opus_bitrate_kbps: u32,
    #[serde(default = "default_blocked_genres")]
    pub music_blocked_genres: Vec<String>,
}

fn default_web_port() -> u16 {
    DEFAULT_WEB_PORT
}
fn default_bind() -> String {
    DEFAULT_BIND.into()
}
fn default_locale() -> String {
    "en".into()
}
fn default_theme() -> String {
    "dark".into()
}
fn default_prefix() -> String {
    "!".into()
}
fn default_trust_proxy_hops() -> u32 {
    1
}
fn default_true() -> bool {
    true
}
fn default_music_opus() -> u32 {
    64
}
fn default_blocked_genres() -> Vec<String> {
    DEFAULT_MUSIC_BLOCKED_GENRES
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}

impl Default for BotConfig {
    fn default() -> Self {
        Self {
            web_port: DEFAULT_WEB_PORT,
            bind_address: DEFAULT_BIND.into(),
            locale: default_locale(),
            theme: default_theme(),
            command_prefix: default_prefix(),
            public_url: String::new(),
            trust_proxy: false,
            trust_proxy_hops: 1,
            llm_enabled: false,
            llm_url: String::new(),
            llm_model: String::new(),
            llm_fallback_url: String::new(),
            llm_fallback_model: String::new(),
            embedding_url: String::new(),
            embedding_model: String::new(),
            rights_enabled: true,
            poke_commands_enabled: true,
            music_opus_bitrate_kbps: 64,
            music_blocked_genres: default_blocked_genres(),
        }
    }
}

impl BotConfig {
    /// Bind used by the HTTP server: `BIND_ADDRESS` env, else config, else localhost.
    pub fn bind_host(&self) -> String {
        std::env::var("BIND_ADDRESS")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| self.bind_address.clone())
    }

    pub fn bind_addr(&self) -> String {
        format!("{}:{}", self.bind_host(), self.web_port)
    }
}

/// Paths the bot process uses. Matches Node: config + db under the data volume.
#[derive(Debug, Clone)]
pub struct Paths {
    pub data_dir: PathBuf,
    pub config_path: PathBuf,
    pub db_path: PathBuf,
    pub static_dir: Option<PathBuf>,
}

impl Paths {
    /// Resolve from env / cwd.
    ///
    /// - `MONEYPENNY_DATA_DIR` or default `bot/data` (then `./data`)
    /// - DB: `data/moneypenny.db`
    /// - Config: `data/config.json`
    /// - SPA: `MONEYPENNY_WEB_DIST` or `bot/web/dist` if present
    pub fn resolve() -> Self {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let data_dir = std::env::var("MONEYPENNY_DATA_DIR")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let bot_data = cwd.join("bot/data");
                if bot_data.is_dir() {
                    bot_data
                } else {
                    cwd.join("data")
                }
            });
        let config_path = data_dir.join("config.json");
        let db_path = data_dir.join("moneypenny.db");
        let static_dir = std::env::var("MONEYPENNY_WEB_DIST")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                let p = cwd.join("bot/web/dist");
                p.is_dir().then_some(p)
            });
        Self {
            data_dir,
            config_path,
            db_path,
            static_dir,
        }
    }
}

pub fn load_config(path: &Path) -> Result<BotConfig> {
    match fs::read_to_string(path) {
        Ok(raw) => {
            let value: Value = serde_json::from_str(&raw)?;
            let mut cfg: BotConfig = serde_json::from_value(value)?;
            apply_env(&mut cfg);
            Ok(cfg)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut cfg = BotConfig::default();
            apply_env(&mut cfg);
            Ok(cfg)
        }
        Err(source) => Err(ConfigError::Io {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn apply_env(cfg: &mut BotConfig) {
    if let Ok(v) = std::env::var("BIND_ADDRESS") {
        if !v.is_empty() {
            cfg.bind_address = v;
        }
    }
    if let Ok(v) = std::env::var("BOT_WEB_PORT") {
        if let Ok(p) = v.parse() {
            cfg.web_port = p;
        }
    }
    if cfg.llm_url.is_empty() {
        if let Ok(v) = std::env::var("RKLLAMA_URL") {
            cfg.llm_url = v;
        }
    }
    if cfg.llm_model.is_empty() {
        if let Ok(v) = std::env::var("RKLLAMA_MODEL") {
            cfg.llm_model = v;
        }
    }
    if cfg.embedding_url.is_empty() {
        if let Ok(v) = std::env::var("EMBEDDING_URL") {
            cfg.embedding_url = v;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_node() {
        let c = BotConfig::default();
        assert_eq!(c.web_port, 3000);
        assert_eq!(c.bind_address, "127.0.0.1");
        assert_eq!(c.command_prefix, "!");
        assert!(c.rights_enabled);
        assert_eq!(c.music_opus_bitrate_kbps, 64);
        assert!(c.music_blocked_genres.iter().any(|g| g == "rap"));
        assert_eq!(SESSION_COOKIE_NAME, "moneypenny_session");
        assert_eq!(BCRYPT_COST, 12);
    }

    #[test]
    fn missing_file_is_defaults() {
        let cfg = load_config(Path::new("/no/such/config.json")).unwrap();
        assert_eq!(cfg.web_port, 3000);
    }

    #[test]
    fn json_overlay() {
        let dir = std::env::temp_dir().join(format!("mp-config-{}", uuid_like()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        fs::write(&path, r#"{"webPort": 4000, "commandPrefix": "?"}"#).unwrap();
        let cfg = load_config(&path).unwrap();
        assert_eq!(cfg.web_port, 4000);
        assert_eq!(cfg.command_prefix, "?");
        assert_eq!(cfg.bind_address, "127.0.0.1");
        let _ = fs::remove_dir_all(&dir);
    }

    fn uuid_like() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64
    }
}
