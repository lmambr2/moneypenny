// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! MCP tool surface (rewrite Phase 8). Confirm-for-high-impact.
//! Protocol helpers only — HTTP mount + dispose live in `mp-http`.

use serde::{Deserialize, Serialize};

pub const HIGH_IMPACT_TOOLS: &[&str] = &[
    "music_ban",
    "music_stop",
    "music_clear",
    "mod_mute",
    "mod_kick",
];

pub const MCP_TOOL_NAMES_BASE: &[&str] = &[
    "status_health",
    "status_now_playing",
    "status_queue",
    "status_radio",
    "status_rag",
    "music_play",
    "music_add",
    "music_play_next",
    "music_skip",
    "music_pause",
    "music_resume",
    "music_ban",
    "music_unban",
    "music_stop",
    "music_clear",
    "music_volume",
    "music_mode",
    "music_history",
    "radio_set",
    "doctrine_list",
    "doctrine_reindex",
    "doctrine_ingest_status",
    "memory_remember",
    "memory_recall",
    "memory_forget",
    "rag_search",
    "rag_ask",
    "harness_turn",
    "harness_turns",
    "econ_run",
    "workorder_run",
    "work_items",
    "generate_music",
];

pub const MCP_MODERATION_TOOLS: &[&str] = &["mod_mute", "mod_kick"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpProfile {
    Readonly,
    Dj,
    Admin,
}

impl McpProfile {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "admin" => Self::Admin,
            "dj" => Self::Dj,
            _ => Self::Readonly,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Readonly => "readonly",
            Self::Dj => "dj",
            Self::Admin => "admin",
        }
    }

    fn rank(self) -> i32 {
        match self {
            Self::Readonly => 0,
            Self::Dj => 1,
            Self::Admin => 2,
        }
    }

    pub fn allows(self, required: McpProfile) -> bool {
        self.rank() >= required.rank()
    }
}

#[derive(Debug, Clone)]
pub struct McpConfig {
    pub enabled: bool,
    pub token: String,
    pub path: String,
    pub bot_id: Option<String>,
    pub default_profile: McpProfile,
    pub enable_moderation: bool,
    pub require_confirm: bool,
    pub invoker_name: String,
    pub invoker_uid: String,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            token: String::new(),
            path: "/mcp".into(),
            bot_id: None,
            default_profile: McpProfile::Readonly,
            enable_moderation: false,
            require_confirm: true,
            invoker_name: "grok-build".into(),
            invoker_uid: "mcp:service".into(),
        }
    }
}

fn env_truthy(v: Option<String>) -> bool {
    match v {
        None => false,
        Some(s) => {
            let t = s.trim().to_ascii_lowercase();
            t == "1" || t == "true" || t == "yes" || t == "on"
        }
    }
}

impl McpConfig {
    pub fn from_env() -> Self {
        let token = std::env::var("MCP_TOKEN").unwrap_or_default().trim().to_string();
        let enabled = env_truthy(std::env::var("MCP_ENABLED").ok()) && !token.is_empty();
        let mut path = std::env::var("MCP_PATH").unwrap_or_else(|_| "/mcp".into());
        path = path.trim().to_string();
        if path.is_empty() {
            path = "/mcp".into();
        }
        if !path.starts_with('/') {
            path = format!("/{path}");
        }
        if path.len() > 1 && path.ends_with('/') {
            path.pop();
        }
        let require_raw = std::env::var("MCP_REQUIRE_CONFIRM").ok();
        let require_confirm = match require_raw.as_deref() {
            None | Some("") => true,
            Some(s) => env_truthy(Some(s.to_string())),
        };
        let bot_id = std::env::var("MCP_BOT_ID")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        Self {
            enabled,
            token,
            path,
            bot_id,
            default_profile: McpProfile::parse(
                &std::env::var("MCP_DEFAULT_PROFILE").unwrap_or_else(|_| "readonly".into()),
            ),
            enable_moderation: env_truthy(std::env::var("MCP_ENABLE_MODERATION").ok()),
            require_confirm,
            invoker_name: std::env::var("MCP_INVOKER_NAME")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "grok-build".into()),
            invoker_uid: std::env::var("MCP_INVOKER_UID")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "mcp:service".into()),
        }
    }

    pub fn tool_names(&self) -> Vec<&'static str> {
        if self.enable_moderation {
            MCP_TOOL_NAMES_BASE
                .iter()
                .copied()
                .chain(MCP_MODERATION_TOOLS.iter().copied())
                .collect()
        } else {
            MCP_TOOL_NAMES_BASE.to_vec()
        }
    }
}

pub fn is_high_impact(name: &str) -> bool {
    HIGH_IMPACT_TOOLS.iter().any(|t| *t == name)
}

/// Timing-safe-ish compare (equal length XOR fold).
pub fn token_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn extract_bearer(authorization: Option<&str>) -> Option<String> {
    let h = authorization?.trim();
    if h.len() <= 6 {
        return None;
    }
    if !h.get(..6).unwrap_or("").eq_ignore_ascii_case("bearer") {
        return None;
    }
    let rest = &h[6..];
    if rest.is_empty() || !rest.as_bytes().first().is_some_and(|c| c.is_ascii_whitespace()) {
        return None;
    }
    let token = rest.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct McpEnvelope<T> {
    pub ok: bool,
    pub code: String,
    pub message: String,
    pub data: Option<T>,
    pub meta: McpMeta,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<String>,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

pub fn ok_envelope<T: Serialize>(
    message: impl Into<String>,
    data: Option<T>,
    bot_id: Option<String>,
    started: std::time::Instant,
    request_id: &str,
) -> McpEnvelope<T> {
    McpEnvelope {
        ok: true,
        code: "OK".into(),
        message: message.into(),
        data,
        meta: McpMeta {
            bot_id,
            duration_ms: started.elapsed().as_millis() as u64,
            request_id: Some(request_id.to_string()),
        },
    }
}

pub fn err_envelope(
    code: impl Into<String>,
    message: impl Into<String>,
    bot_id: Option<String>,
    started: std::time::Instant,
    request_id: &str,
) -> McpEnvelope<serde_json::Value> {
    McpEnvelope {
        ok: false,
        code: code.into(),
        message: message.into(),
        data: None,
        meta: McpMeta {
            bot_id,
            duration_ms: started.elapsed().as_millis() as u64,
            request_id: Some(request_id.to_string()),
        },
    }
}

/// Returns a NEEDS_CONFIRMATION envelope when the tool is high-impact and
/// `confirm` was not true. Never sits on the skip path — skip is not high-impact.
pub fn check_confirm(
    cfg: &McpConfig,
    tool_name: &str,
    confirm: bool,
    bot_id: Option<String>,
    started: std::time::Instant,
    request_id: &str,
) -> Option<McpEnvelope<serde_json::Value>> {
    if !cfg.require_confirm {
        return None;
    }
    if !is_high_impact(tool_name) {
        return None;
    }
    if confirm {
        return None;
    }
    Some(err_envelope(
        "NEEDS_CONFIRMATION",
        format!(
            "Tool '{tool_name}' is high-impact. Re-call with confirm: true after operator approval."
        ),
        bot_id,
        started,
        request_id,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crate_compiles() {
        assert_eq!(env!("CARGO_PKG_NAME"), "mp-mcp");
    }

    #[test]
    fn confirm_blocks_stop_not_skip() {
        let cfg = McpConfig {
            require_confirm: true,
            ..McpConfig::default()
        };
        let t = std::time::Instant::now();
        assert!(check_confirm(&cfg, "music_stop", false, None, t, "r").is_some());
        assert!(check_confirm(&cfg, "music_stop", true, None, t, "r").is_none());
        assert!(check_confirm(&cfg, "music_skip", false, None, t, "r").is_none());
    }

    #[test]
    fn profile_parse_fail_closed() {
        assert_eq!(McpProfile::parse(""), McpProfile::Readonly);
        assert_eq!(McpProfile::parse("nope"), McpProfile::Readonly);
        assert_eq!(McpProfile::parse("admin"), McpProfile::Admin);
        assert_eq!(McpConfig::default().default_profile, McpProfile::Readonly);
    }

    #[test]
    fn bearer_parse() {
        assert_eq!(extract_bearer(Some("Bearer secret")), Some("secret".into()));
        assert_eq!(extract_bearer(Some("BearerXYZ")), None);
        assert!(token_eq("abc", "abc"));
        assert!(!token_eq("abc", "abd"));
        assert!(!token_eq("abc", "ab"));
    }

    #[test]
    fn profile_ladder() {
        assert!(McpProfile::Admin.allows(McpProfile::Dj));
        assert!(!McpProfile::Readonly.allows(McpProfile::Dj));
    }
}
