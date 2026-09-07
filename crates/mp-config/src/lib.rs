// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Runtime config: `data/config.json` + env overlays.
//!
//! Defaults match `bot/src/data/config.ts` `getDefaultConfig()` at ec464a2.
//! Settings PATCH merges into the on-disk JSON (unknown keys kept). Write only
//! the rewrite worktree `data/config.json` — never the production Node tree.

use std::collections::HashMap;
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
/// Unknown JSON keys are ignored (we do not round-trip-save during dual-run).
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
    #[serde(default = "default_aliases")]
    pub command_aliases: HashMap<String, String>,
    #[serde(default)]
    pub admin_groups: Vec<i32>,
    #[serde(default)]
    pub playback_ban_protected_artists: Vec<String>,
    #[serde(default)]
    pub rights: Option<Value>,
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
    pub llm_system_prompt: String,
    #[serde(default = "default_llm_temperature")]
    pub llm_temperature: f32,
    #[serde(default)]
    pub embedding_url: String,
    #[serde(default)]
    pub embedding_model: String,
    #[serde(default)]
    pub vector_db_url: String,
    #[serde(default)]
    pub rag_enabled: bool,
    #[serde(default = "default_rag_top_k")]
    pub rag_top_k: u32,
    #[serde(default = "default_rag_collection")]
    pub rag_collection: String,
    #[serde(default)]
    pub memory_enabled: bool,
    #[serde(default)]
    pub rights_enabled: bool,
    #[serde(default = "default_true")]
    pub poke_commands_enabled: bool,
    #[serde(default = "default_music_opus")]
    pub music_opus_bitrate_kbps: u32,
    #[serde(default = "default_blocked_genres")]
    pub music_blocked_genres: Vec<String>,
    /// Inbound voice loop (rewrite Phase 6). Nested object matches Node `config.voice`.
    #[serde(default)]
    pub voice: VoiceConfig,
    /// Autonomous DJ (rewrite Phase 7). Nested object matches Node `config.radio`.
    #[serde(default)]
    pub radio: RadioConfig,
    /// Roast community layer (rewrite Phase 8). Off by default.
    #[serde(default)]
    pub roast_enabled: bool,
    #[serde(default = "default_roast_min_present")]
    pub roast_min_present: u32,
    #[serde(default = "default_roast_cooldown")]
    pub roast_cooldown_minutes: u32,
    #[serde(default = "default_roast_min_score")]
    pub roast_min_score: i64,
}

/// Node `VoiceConfig` (`bot/src/voice/types.ts`). Load-only during dual-run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub respond_with_voice: bool,
    #[serde(default)]
    pub stt_url: String,
    #[serde(default)]
    pub tts_url: String,
    #[serde(default = "default_tts_voice")]
    pub tts_voice: String,
    #[serde(default = "default_energy_threshold")]
    pub energy_threshold: f64,
    #[serde(default = "default_watchword")]
    pub watchword: String,
    #[serde(default = "default_true")]
    pub require_watchword: bool,
    #[serde(default = "default_true")]
    pub duck_music_on_speech: bool,
    #[serde(default = "default_duck_volume")]
    pub duck_music_volume: u32,
    #[serde(default)]
    pub karaoke_mode: bool,
    #[serde(default = "default_listen_window_ms")]
    pub listen_window_ms: u64,
    /// Whisper has no KWS — prefix text wake is required (Node default true).
    #[serde(default = "default_true")]
    pub text_wake_fallback: bool,
}

pub const DEFAULT_DUCK_MUSIC_VOLUME: u32 = 15;
pub const KARAOKE_DUCK_VOLUME: u32 = 80;
pub const MIN_LISTEN_WINDOW_MS: u64 = 15_000;

pub fn normalize_duck_music_volume(raw: Option<u32>) -> u32 {
    let duck = match raw {
        None | Some(2) | Some(20) | Some(25) => DEFAULT_DUCK_MUSIC_VOLUME,
        Some(v) => v,
    };
    duck.min(100)
}

pub fn effective_duck_volume(karaoke_mode: bool, duck_music_volume: u32) -> u32 {
    if karaoke_mode {
        KARAOKE_DUCK_VOLUME
    } else {
        normalize_duck_music_volume(Some(duck_music_volume))
    }
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
fn default_aliases() -> HashMap<String, String> {
    HashMap::from([
        ("p".into(), "play".into()),
        ("s".into(), "skip".into()),
        ("n".into(), "skip".into()),
    ])
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
fn default_llm_temperature() -> f32 {
    0.2
}
fn default_rag_top_k() -> u32 {
    6
}
fn default_rag_collection() -> String {
    "moneypenny_docs".into()
}
fn default_tts_voice() -> String {
    "en_GB-cori-high".into()
}
fn default_energy_threshold() -> f64 {
    200.0
}
fn default_watchword() -> String {
    "moneypenny".into()
}
fn default_duck_volume() -> u32 {
    DEFAULT_DUCK_MUSIC_VOLUME
}
fn default_listen_window_ms() -> u64 {
    15_000
}
fn default_roast_min_present() -> u32 {
    3
}
fn default_roast_cooldown() -> u32 {
    180
}
fn default_roast_min_score() -> i64 {
    4
}

impl Default for VoiceConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            respond_with_voice: true,
            stt_url: String::new(),
            tts_url: String::new(),
            tts_voice: default_tts_voice(),
            energy_threshold: 200.0,
            watchword: default_watchword(),
            require_watchword: true,
            duck_music_on_speech: true,
            duck_music_volume: DEFAULT_DUCK_MUSIC_VOLUME,
            karaoke_mode: false,
            listen_window_ms: 15_000,
            text_wake_fallback: true,
        }
    }
}

/// Bumper content sources (`docs/radio.md`). LLM sources are declared but unused in Phase 7.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BumperSource {
    Prerecorded,
    StationId,
    TimeCheck,
    NowPlaying,
    Doctrine,
    Memory,
}

impl BumperSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Prerecorded => "prerecorded",
            Self::StationId => "stationId",
            Self::TimeCheck => "timeCheck",
            Self::NowPlaying => "nowPlaying",
            Self::Doctrine => "doctrine",
            Self::Memory => "memory",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SlotKind {
    Song,
    Bumper,
    StationId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WheelSlot {
    pub slot: SlotKind,
    #[serde(default)]
    pub sources: Vec<BumperSource>,
    #[serde(default)]
    pub topic: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FormatClockSpec {
    #[serde(default)]
    pub wheel: Vec<WheelSlot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RadioMusic {
    #[serde(default)]
    pub seed_queries: Vec<String>,
    #[serde(default = "default_true")]
    pub shuffle: bool,
    /// `local` | `youtube` | `stream`. Default local+youtube like Node.
    #[serde(default = "default_seed_sources")]
    pub seed_sources: Vec<String>,
    /// Target share of the pool from non-local sources (0–1). Default ⅔.
    #[serde(default = "default_seed_external_ratio")]
    pub seed_external_ratio: f64,
}

impl Default for RadioMusic {
    fn default() -> Self {
        Self {
            seed_queries: Vec::new(),
            shuffle: true,
            seed_sources: default_seed_sources(),
            seed_external_ratio: default_seed_external_ratio(),
        }
    }
}

fn default_seed_sources() -> Vec<String> {
    vec!["local".into(), "youtube".into()]
}

fn default_seed_external_ratio() -> f64 {
    2.0 / 3.0
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RadioBumper {
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub tone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RadioProfile {
    pub name: String,
    #[serde(default)]
    pub music: RadioMusic,
    #[serde(default)]
    pub bumper: RadioBumper,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuietWindow {
    pub from: String,
    pub to: String,
}

/// Node `RadioConfig` (`bot/src/radio/types.ts`). Off by default.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RadioConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_every_n")]
    pub every_n_songs: u32,
    #[serde(default = "default_dead_air")]
    pub dead_air_seconds: u64,
    #[serde(default = "default_max_bumper")]
    pub max_bumper_seconds: u32,
    #[serde(default = "default_speech_vol")]
    pub speech_volume_pct: u32,
    #[serde(default = "default_min_present")]
    pub min_present_to_broadcast: u32,
    #[serde(default = "default_empty_stop")]
    pub empty_channel_stop_seconds: i32,
    #[serde(default = "default_cooldown")]
    pub cooldown_seconds: u64,
    #[serde(default = "default_max_bumpers_hour")]
    pub max_bumpers_per_hour: u32,
    #[serde(default)]
    pub quiet_hours: Vec<QuietWindow>,
    #[serde(default = "default_radio_sources")]
    pub sources: Vec<BumperSource>,
    #[serde(default)]
    pub memory_broadcast_opt_in: bool,
    #[serde(default = "default_active_profile")]
    pub active_profile: String,
    #[serde(default = "default_radio_profiles")]
    pub profiles: HashMap<String, RadioProfile>,
    #[serde(default)]
    pub clock: Option<FormatClockSpec>,
    #[serde(default)]
    pub tts_voice: Option<String>,
    #[serde(default)]
    pub station_id_lines: Vec<String>,
    #[serde(default)]
    pub time_check_timezones: Vec<String>,
}

fn default_every_n() -> u32 {
    4
}
fn default_dead_air() -> u64 {
    25
}
fn default_max_bumper() -> u32 {
    30
}
fn default_speech_vol() -> u32 {
    85
}
fn default_min_present() -> u32 {
    1
}
fn default_empty_stop() -> i32 {
    10
}
fn default_cooldown() -> u64 {
    180
}
fn default_max_bumpers_hour() -> u32 {
    12
}
fn default_active_profile() -> String {
    "lobby".into()
}
fn default_radio_sources() -> Vec<BumperSource> {
    vec![
        BumperSource::Prerecorded,
        BumperSource::StationId,
        BumperSource::TimeCheck,
        BumperSource::NowPlaying,
    ]
}
fn default_radio_profiles() -> HashMap<String, RadioProfile> {
    let mut m = HashMap::new();
    m.insert(
        "lobby".into(),
        RadioProfile {
            name: "lobby".into(),
            music: RadioMusic {
                seed_queries: vec!["chill".into(), "ambient".into()],
                ..Default::default()
            },
            bumper: RadioBumper {
                topics: vec![
                    "station".into(),
                    "welcome".into(),
                    "org announcements".into(),
                    "code of conduct".into(),
                ],
                tone: "Colonel Moneypenny: dry poised British colonel-and-secretary wit".into(),
            },
        },
    );
    m.insert(
        "focus".into(),
        RadioProfile {
            name: "focus".into(),
            music: RadioMusic {
                seed_queries: vec!["focus".into(), "ambient".into()],
                ..Default::default()
            },
            bumper: RadioBumper {
                topics: vec!["ops".into(), "briefing".into()],
                tone: "Colonel Moneypenny: dry British composure".into(),
            },
        },
    );
    m
}

impl Default for RadioConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            every_n_songs: 4,
            dead_air_seconds: 25,
            max_bumper_seconds: 30,
            speech_volume_pct: 85,
            min_present_to_broadcast: 1,
            empty_channel_stop_seconds: 10,
            cooldown_seconds: 180,
            max_bumpers_per_hour: 12,
            quiet_hours: Vec::new(),
            sources: default_radio_sources(),
            memory_broadcast_opt_in: false,
            active_profile: "lobby".into(),
            profiles: default_radio_profiles(),
            clock: None,
            tts_voice: None,
            station_id_lines: Vec::new(),
            time_check_timezones: Vec::new(),
        }
    }
}

impl Default for BotConfig {
    fn default() -> Self {
        Self {
            web_port: DEFAULT_WEB_PORT,
            bind_address: DEFAULT_BIND.into(),
            locale: default_locale(),
            theme: default_theme(),
            command_prefix: default_prefix(),
            command_aliases: default_aliases(),
            admin_groups: Vec::new(),
            playback_ban_protected_artists: Vec::new(),
            rights: None,
            public_url: String::new(),
            trust_proxy: false,
            trust_proxy_hops: 1,
            llm_enabled: false,
            llm_url: String::new(),
            llm_model: String::new(),
            llm_fallback_url: String::new(),
            llm_fallback_model: String::new(),
            llm_system_prompt: String::new(),
            llm_temperature: 0.2,
            embedding_url: String::new(),
            embedding_model: String::new(),
            vector_db_url: String::new(),
            rag_enabled: false,
            rag_top_k: 6,
            rag_collection: "moneypenny_docs".into(),
            memory_enabled: false,
            rights_enabled: true,
            poke_commands_enabled: true,
            music_opus_bitrate_kbps: 64,
            music_blocked_genres: default_blocked_genres(),
            voice: VoiceConfig::default(),
            radio: RadioConfig::default(),
            roast_enabled: false,
            roast_min_present: 3,
            roast_cooldown_minutes: 180,
            roast_min_score: 4,
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

/// Deep-merge `patch` into the JSON file at `path` and write pretty JSON.
/// Empty path is a no-op (tests / HTTP-only). Unknown existing keys are kept.
pub fn save_config_merge(path: &Path, patch: &Value) -> Result<()> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    let mut root = match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|_| json_object()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json_object(),
        Err(source) => {
            return Err(ConfigError::Io {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    if !root.is_object() {
        root = json_object();
    }
    merge_json_objects(&mut root, patch);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|source| ConfigError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
        }
    }
    let pretty = serde_json::to_string_pretty(&root)?;
    fs::write(path, format!("{pretty}\n")).map_err(|source| ConfigError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    Ok(())
}

fn json_object() -> Value {
    Value::Object(serde_json::Map::new())
}

fn merge_json_objects(dst: &mut Value, patch: &Value) {
    let Some(patch_obj) = patch.as_object() else {
        *dst = patch.clone();
        return;
    };
    let Some(dst_obj) = dst.as_object_mut() else {
        *dst = patch.clone();
        return;
    };
    for (k, v) in patch_obj {
        if v.is_object() {
            let entry = dst_obj.entry(k.clone()).or_insert_with(json_object);
            if entry.is_object() {
                merge_json_objects(entry, v);
                continue;
            }
        }
        dst_obj.insert(k.clone(), v.clone());
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
    if cfg.vector_db_url.is_empty() {
        if let Ok(v) = std::env::var("VECTOR_DB_URL") {
            if !v.is_empty() {
                cfg.vector_db_url = v;
            }
        }
    }
    if let Ok(v) = std::env::var("RAG_ENABLED") {
        let t = v.trim();
        if t == "1" || t.eq_ignore_ascii_case("true") {
            cfg.rag_enabled = true;
        }
    }
    if let Ok(v) = std::env::var("MEMORY_ENABLED") {
        let t = v.trim();
        if t == "1" || t.eq_ignore_ascii_case("true") {
            cfg.memory_enabled = true;
        }
    }
    if let Ok(v) = std::env::var("LLM_ENABLED") {
        let t = v.trim();
        if t == "1" || t.eq_ignore_ascii_case("true") {
            cfg.llm_enabled = true;
        } else if t == "0" || t.eq_ignore_ascii_case("false") {
            cfg.llm_enabled = false;
        }
    }
    if cfg.llm_url.is_empty() {
        if let Ok(v) = std::env::var("LLM_URL") {
            if !v.is_empty() {
                cfg.llm_url = v;
            }
        }
    }
    if cfg.llm_model.is_empty() {
        if let Ok(v) = std::env::var("LLM_MODEL") {
            if !v.is_empty() {
                cfg.llm_model = v;
            }
        }
    }
    if let Ok(v) = std::env::var("VOICE_ENABLED") {
        let t = v.trim();
        if t == "1" || t.eq_ignore_ascii_case("true") {
            cfg.voice.enabled = true;
        } else if t == "0" || t.eq_ignore_ascii_case("false") {
            cfg.voice.enabled = false;
        }
    }
    if cfg.voice.stt_url.is_empty() {
        if let Ok(v) = std::env::var("STT_URL") {
            if !v.is_empty() {
                cfg.voice.stt_url = v;
            }
        }
    }
    if cfg.voice.tts_url.is_empty() {
        if let Ok(v) = std::env::var("TTS_URL") {
            if !v.is_empty() {
                cfg.voice.tts_url = v;
            }
        }
    }
    if let Ok(v) = std::env::var("TTS_VOICE") {
        if !v.is_empty() {
            cfg.voice.tts_voice = v;
        }
    }
    if let Ok(v) = std::env::var("RADIO_ENABLED") {
        let t = v.trim();
        if t == "1" || t.eq_ignore_ascii_case("true") {
            cfg.radio.enabled = true;
        } else if t == "0" || t.eq_ignore_ascii_case("false") {
            cfg.radio.enabled = false;
        }
    }
    if let Ok(v) = std::env::var("ROAST_ENABLED") {
        let t = v.trim();
        if t == "1" || t.eq_ignore_ascii_case("true") {
            cfg.roast_enabled = true;
        } else if t == "0" || t.eq_ignore_ascii_case("false") {
            cfg.roast_enabled = false;
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
        assert_eq!(c.command_aliases.get("p").map(String::as_str), Some("play"));
        assert!(c.rights_enabled);
        assert_eq!(c.music_opus_bitrate_kbps, 64);
        assert!(c.music_blocked_genres.iter().any(|g| g == "rap"));
        assert!(!c.voice.enabled);
        assert_eq!(c.voice.watchword, "moneypenny");
        assert_eq!(c.voice.energy_threshold, 200.0);
        assert!(c.voice.text_wake_fallback);
        assert!(!c.radio.enabled);
        assert_eq!(c.radio.every_n_songs, 4);
        assert_eq!(c.radio.active_profile, "lobby");
        assert!(!c.roast_enabled);
        assert_eq!(c.roast_min_present, 3);
        assert_eq!(c.roast_min_score, 4);
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

    #[test]
    fn merge_keeps_unknown_keys() {
        let dir = std::env::temp_dir().join(format!("mp-config-save-{}", uuid_like()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        fs::write(
            &path,
            r#"{"webPort": 3000, "customExtra": "keep-me", "voice": {"enabled": false, "watchword": "moneypenny"}}"#,
        )
        .unwrap();
        save_config_merge(
            &path,
            &serde_json::json!({
                "llmEnabled": true,
                "voice": { "enabled": true }
            }),
        )
        .unwrap();
        let raw: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["customExtra"], "keep-me");
        assert_eq!(raw["llmEnabled"], true);
        assert_eq!(raw["voice"]["enabled"], true);
        assert_eq!(raw["voice"]["watchword"], "moneypenny");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_path_is_noop() {
        save_config_merge(Path::new(""), &serde_json::json!({"llmEnabled": true})).unwrap();
    }

    fn uuid_like() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64
    }
}
