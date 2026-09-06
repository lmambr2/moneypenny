// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Rank-gating RightsEngine (DESIGN §8). Port of `bot/src/rights/index.ts`.
//!
//! Default-deny. UID / server-group / channel-group, deny wins, scope
//! voice|chat|both, `superAdminUids` bypass. Nickname match for web↔TS is
//! exact (case-insensitive) and lives in [`nickname_matches_username`].

use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subject {
    pub uid: String,
    pub server_groups: Vec<String>,
    pub nickname: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Voice,
    Chat,
    Both,
}

impl Default for Scope {
    fn default() -> Self {
        Self::Both
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RuleMatch {
    #[serde(default)]
    pub uids: Option<Vec<String>>,
    #[serde(default, rename = "serverGroups")]
    pub server_groups: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RightsRule {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, rename = "match")]
    pub r#match: RuleMatch,
    #[serde(default)]
    pub allow: Option<Vec<String>>,
    #[serde(default)]
    pub deny: Option<Vec<String>>,
    #[serde(default)]
    pub scope: Option<Scope>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RightsConfig {
    #[serde(default)]
    pub default_allow: Option<Vec<String>>,
    #[serde(default)]
    pub command_groups: Option<HashMap<String, Vec<String>>>,
    #[serde(default)]
    pub super_admin_uids: Option<Vec<String>>,
    #[serde(default)]
    pub rules: Option<Vec<RightsRule>>,
}

pub struct RightsEngine {
    config: RwLock<RightsConfig>,
}

impl RightsEngine {
    pub fn new(config: RightsConfig) -> Self {
        Self {
            config: RwLock::new(config),
        }
    }

    /// Hot-reload the ruleset (atomic swap).
    pub fn reload(&self, config: RightsConfig) {
        *self.config.write().expect("rights mutex") = config;
    }

    pub fn can(&self, subject: &Subject, command: &str, context: Scope) -> bool {
        if self.is_super_admin(subject) {
            return true;
        }
        let allowed = self.compute_allowed(subject, context);
        allowed.contains("*") || allowed.contains(&command.to_lowercase())
    }

    pub fn compute_allowed(&self, subject: &Subject, context: Scope) -> HashSet<String> {
        let cfg = self.config.read().expect("rights mutex");
        let mut set = HashSet::new();
        self.apply_allow(&cfg, &mut set, cfg.default_allow.as_deref());
        for rule in cfg.rules.as_deref().unwrap_or(&[]) {
            if !matches_rule(rule, subject) {
                continue;
            }
            if let Some(scope) = rule.scope {
                if scope != Scope::Both && scope != context {
                    continue;
                }
            }
            self.apply_allow(&cfg, &mut set, rule.allow.as_deref());
            self.apply_deny(&cfg, &mut set, rule.deny.as_deref());
        }
        set
    }

    fn is_super_admin(&self, subject: &Subject) -> bool {
        let cfg = self.config.read().expect("rights mutex");
        cfg.super_admin_uids
            .as_deref()
            .is_some_and(|uids| uids.iter().any(|u| u == &subject.uid))
    }

    fn expand(&self, cfg: &RightsConfig, token: &str) -> Vec<String> {
        if token == "*" {
            return vec!["*".into()];
        }
        if let Some(name) = token.strip_prefix('@') {
            return cfg
                .command_groups
                .as_ref()
                .and_then(|g| g.get(name))
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|c| c.to_lowercase())
                .collect();
        }
        vec![token.to_lowercase()]
    }

    fn apply_allow(&self, cfg: &RightsConfig, set: &mut HashSet<String>, tokens: Option<&[String]>) {
        for t in tokens.unwrap_or(&[]) {
            for c in self.expand(cfg, t) {
                set.insert(c);
            }
        }
    }

    fn apply_deny(&self, cfg: &RightsConfig, set: &mut HashSet<String>, tokens: Option<&[String]>) {
        for t in tokens.unwrap_or(&[]) {
            if t == "*" {
                set.clear();
                continue;
            }
            for c in self.expand(cfg, t) {
                set.remove(&c);
            }
        }
    }
}

fn matches_rule(rule: &RightsRule, subject: &Subject) -> bool {
    let uids = rule.r#match.uids.as_deref().unwrap_or(&[]);
    let groups = rule.r#match.server_groups.as_deref().unwrap_or(&[]);
    if uids.is_empty() && groups.is_empty() {
        return true;
    }
    if !uids.is_empty() && uids.iter().any(|u| u == &subject.uid) {
        return true;
    }
    if !groups.is_empty() && groups.iter().any(|g| subject.server_groups.iter().any(|s| s == g)) {
        return true;
    }
    false
}

const ANALYST_COMMANDS: &[&str] = &["analyst", "agent"];

/// Legacy public/admin split. `public`/`admin` are command-name lists
/// (plus extra admin tokens). Analyst/agent are stripped from defaultAllow
/// and granted only via the admin group rule.
pub fn default_rights_config<I, J, S, T>(
    public: I,
    admin: J,
    admin_groups: &[i32],
) -> RightsConfig
where
    I: IntoIterator<Item = S>,
    J: IntoIterator<Item = T>,
    S: AsRef<str>,
    T: AsRef<str>,
{
    let public_default: Vec<String> = public
        .into_iter()
        .map(|c| c.as_ref().to_lowercase())
        .filter(|c| !ANALYST_COMMANDS.contains(&c.as_str()))
        .collect();
    let admin_cmds: Vec<String> = admin
        .into_iter()
        .map(|c| c.as_ref().to_lowercase())
        .collect();
    let rules = if admin_groups.is_empty() {
        Vec::new()
    } else {
        vec![RightsRule {
            name: Some("admins".into()),
            r#match: RuleMatch {
                uids: None,
                server_groups: Some(admin_groups.iter().map(|g| g.to_string()).collect()),
            },
            allow: Some(vec!["@admin".into(), "@analyst".into()]),
            deny: None,
            scope: None,
        }]
    };
    RightsConfig {
        default_allow: Some(public_default),
        command_groups: Some(HashMap::from([
            ("admin".into(), admin_cmds),
            (
                "analyst".into(),
                ANALYST_COMMANDS.iter().map(|s| (*s).to_string()).collect(),
            ),
        ])),
        super_admin_uids: Some(Vec::new()),
        rules: Some(rules),
    }
}

/// Exact nickname ↔ username match (case-insensitive). Fuzzy match is forbidden.
pub fn nickname_matches_username(nickname: &str, username: &str) -> bool {
    let nick = nickname.trim().to_lowercase();
    let user = username.trim().to_lowercase();
    !nick.is_empty() && !user.is_empty() && nick == user
}

fn is_string_array(v: &serde_json::Value) -> bool {
    v.as_array()
        .is_some_and(|a| a.iter().all(|x| x.is_string()))
}

/// Runtime validation for admin-submitted rights JSON.
pub fn is_rights_config(v: &serde_json::Value) -> bool {
    if v.is_null() || !v.is_object() {
        return false;
    }
    let o = v.as_object().unwrap();
    if let Some(da) = o.get("defaultAllow") {
        if !is_string_array(da) {
            return false;
        }
    }
    if let Some(sa) = o.get("superAdminUids") {
        if !is_string_array(sa) {
            return false;
        }
    }
    if let Some(cg) = o.get("commandGroups") {
        if !cg.is_object() {
            return false;
        }
        for val in cg.as_object().unwrap().values() {
            if !is_string_array(val) {
                return false;
            }
        }
    }
    if let Some(rules) = o.get("rules") {
        if !rules.is_array() {
            return false;
        }
        for rule in rules.as_array().unwrap() {
            if !rule.is_object() {
                return false;
            }
            let r = rule.as_object().unwrap();
            if let Some(n) = r.get("name") {
                if !n.is_string() {
                    return false;
                }
            }
            if let Some(m) = r.get("match") {
                if !m.is_object() {
                    return false;
                }
                let mo = m.as_object().unwrap();
                if let Some(u) = mo.get("uids") {
                    if !is_string_array(u) {
                        return false;
                    }
                }
                if let Some(g) = mo.get("serverGroups") {
                    if !is_string_array(g) {
                        return false;
                    }
                }
            }
            if let Some(a) = r.get("allow") {
                if !is_string_array(a) {
                    return false;
                }
            }
            if let Some(d) = r.get("deny") {
                if !is_string_array(d) {
                    return false;
                }
            }
            if let Some(s) = r.get("scope") {
                match s.as_str() {
                    Some("voice" | "chat" | "both") => {}
                    _ => return false,
                }
            }
        }
    }
    true
}

pub fn parse_rights_config(v: &serde_json::Value) -> Option<RightsConfig> {
    if !is_rights_config(v) {
        return None;
    }
    serde_json::from_value(v.clone()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member() -> Subject {
        Subject {
            uid: "member-uid".into(),
            server_groups: vec!["100".into()],
            nickname: None,
        }
    }
    fn officer() -> Subject {
        Subject {
            uid: "officer-uid".into(),
            server_groups: vec!["105".into()],
            nickname: None,
        }
    }
    fn owner() -> Subject {
        Subject {
            uid: "owner-uid".into(),
            server_groups: vec!["1".into()],
            nickname: None,
        }
    }

    #[test]
    fn allows_default_allow() {
        let e = RightsEngine::new(RightsConfig {
            default_allow: Some(vec!["play".into(), "vote".into()]),
            ..Default::default()
        });
        assert!(e.can(&member(), "play", Scope::Chat));
        assert!(e.can(&member(), "vote", Scope::Chat));
        assert!(!e.can(&member(), "stop", Scope::Chat));
    }

    #[test]
    fn matches_server_group_and_expands_at_groups() {
        let e = RightsEngine::new(RightsConfig {
            default_allow: Some(vec!["play".into()]),
            command_groups: Some(HashMap::from([(
                "admin".into(),
                vec!["stop".into(), "clear".into()],
            )])),
            rules: Some(vec![RightsRule {
                name: Some("officers".into()),
                r#match: RuleMatch {
                    server_groups: Some(vec!["105".into()]),
                    uids: None,
                },
                allow: Some(vec!["@admin".into()]),
                deny: None,
                scope: None,
            }]),
            ..Default::default()
        });
        assert!(e.can(&officer(), "stop", Scope::Chat));
        assert!(e.can(&officer(), "clear", Scope::Chat));
        assert!(!e.can(&member(), "stop", Scope::Chat));
    }

    #[test]
    fn matches_uid() {
        let e = RightsEngine::new(RightsConfig {
            rules: Some(vec![RightsRule {
                name: None,
                r#match: RuleMatch {
                    uids: Some(vec!["member-uid".into()]),
                    server_groups: None,
                },
                allow: Some(vec!["secret".into()]),
                deny: None,
                scope: None,
            }]),
            ..Default::default()
        });
        assert!(e.can(&member(), "secret", Scope::Chat));
        assert!(!e.can(&officer(), "secret", Scope::Chat));
    }

    #[test]
    fn super_admin_bypass() {
        let e = RightsEngine::new(RightsConfig {
            super_admin_uids: Some(vec!["owner-uid".into()]),
            ..Default::default()
        });
        assert!(e.can(&owner(), "anything-at-all", Scope::Chat));
        assert!(!e.can(&member(), "anything-at-all", Scope::Chat));
    }

    #[test]
    fn star_allows_all() {
        let e = RightsEngine::new(RightsConfig {
            rules: Some(vec![RightsRule {
                name: None,
                r#match: RuleMatch {
                    server_groups: Some(vec!["105".into()]),
                    uids: None,
                },
                allow: Some(vec!["*".into()]),
                deny: None,
                scope: None,
            }]),
            ..Default::default()
        });
        assert!(e.can(&officer(), "stop", Scope::Chat));
        assert!(e.can(&officer(), "whatever", Scope::Chat));
    }

    #[test]
    fn deny_within_rule() {
        let e = RightsEngine::new(RightsConfig {
            default_allow: Some(vec!["play".into(), "stop".into()]),
            rules: Some(vec![RightsRule {
                name: None,
                r#match: RuleMatch {
                    server_groups: Some(vec!["100".into()]),
                    uids: None,
                },
                allow: None,
                deny: Some(vec!["stop".into()]),
                scope: None,
            }]),
            ..Default::default()
        });
        assert!(e.can(&member(), "play", Scope::Chat));
        assert!(!e.can(&member(), "stop", Scope::Chat));
    }

    #[test]
    fn deny_star_clears() {
        let e = RightsEngine::new(RightsConfig {
            default_allow: Some(vec!["play".into(), "vote".into()]),
            rules: Some(vec![RightsRule {
                name: Some("muzzle".into()),
                r#match: RuleMatch {
                    uids: Some(vec!["member-uid".into()]),
                    server_groups: None,
                },
                allow: None,
                deny: Some(vec!["*".into()]),
                scope: None,
            }]),
            ..Default::default()
        });
        assert!(!e.can(&member(), "play", Scope::Chat));
        assert!(e.can(&officer(), "play", Scope::Chat));
    }

    #[test]
    fn empty_match_is_global() {
        let e = RightsEngine::new(RightsConfig {
            rules: Some(vec![RightsRule {
                name: None,
                r#match: RuleMatch::default(),
                allow: Some(vec!["help".into()]),
                deny: None,
                scope: None,
            }]),
            ..Default::default()
        });
        assert!(e.can(&member(), "help", Scope::Chat));
        assert!(e.can(&officer(), "help", Scope::Chat));
    }

    #[test]
    fn later_rules_override() {
        let e = RightsEngine::new(RightsConfig {
            rules: Some(vec![
                RightsRule {
                    name: None,
                    r#match: RuleMatch::default(),
                    allow: Some(vec!["stop".into()]),
                    deny: None,
                    scope: None,
                },
                RightsRule {
                    name: None,
                    r#match: RuleMatch {
                        server_groups: Some(vec!["100".into()]),
                        uids: None,
                    },
                    allow: None,
                    deny: Some(vec!["stop".into()]),
                    scope: None,
                },
            ]),
            ..Default::default()
        });
        assert!(e.can(&officer(), "stop", Scope::Chat));
        assert!(!e.can(&member(), "stop", Scope::Chat));
    }

    #[test]
    fn case_insensitive_commands() {
        let e = RightsEngine::new(RightsConfig {
            default_allow: Some(vec!["Play".into()]),
            ..Default::default()
        });
        assert!(e.can(&member(), "play", Scope::Chat));
        assert!(e.can(&member(), "PLAY", Scope::Chat));
    }

    #[test]
    fn reload_swaps() {
        let e = RightsEngine::new(RightsConfig {
            default_allow: Some(vec!["play".into()]),
            ..Default::default()
        });
        assert!(!e.can(&member(), "stop", Scope::Chat));
        e.reload(RightsConfig {
            default_allow: Some(vec!["play".into(), "stop".into()]),
            ..Default::default()
        });
        assert!(e.can(&member(), "stop", Scope::Chat));
    }

    #[test]
    fn scopes_voice_vs_chat() {
        let e = RightsEngine::new(RightsConfig {
            default_allow: Some(vec!["play".into()]),
            rules: Some(vec![RightsRule {
                name: Some("voice-stop".into()),
                r#match: RuleMatch {
                    server_groups: Some(vec!["105".into()]),
                    uids: None,
                },
                allow: Some(vec!["stop".into()]),
                deny: None,
                scope: Some(Scope::Voice),
            }]),
            ..Default::default()
        });
        assert!(e.can(&officer(), "stop", Scope::Voice));
        assert!(!e.can(&officer(), "stop", Scope::Chat));
        let e2 = RightsEngine::new(RightsConfig {
            rules: Some(vec![RightsRule {
                name: None,
                r#match: RuleMatch::default(),
                allow: Some(vec!["skip".into()]),
                deny: None,
                scope: None,
            }]),
            ..Default::default()
        });
        assert!(e2.can(&member(), "skip", Scope::Voice));
        assert!(e2.can(&member(), "skip", Scope::Chat));
    }

    #[test]
    fn default_config_public_vs_admin() {
        let public = ["play", "skip", "queue", "ask", "analyst", "agent"];
        let admin = ["stop", "clear", "vol", "mode"];
        let e = RightsEngine::new(default_rights_config(public, admin, &[]));
        assert!(e.can(&member(), "play", Scope::Chat));
        assert!(!e.can(&member(), "analyst", Scope::Chat));
        assert!(!e.can(&member(), "agent", Scope::Chat));
        assert!(!e.can(&member(), "stop", Scope::Chat));

        let e = RightsEngine::new(default_rights_config(public, admin, &[105]));
        assert!(e.can(&officer(), "stop", Scope::Chat));
        assert!(e.can(&officer(), "analyst", Scope::Chat));
        assert!(!e.can(&member(), "stop", Scope::Chat));
        assert!(e.can(&member(), "play", Scope::Chat));
    }

    #[test]
    fn unknown_command_denied() {
        let e = RightsEngine::new(default_rights_config(["play"], ["stop"], &[105]));
        assert!(!e.can(&officer(), "sudo", Scope::Chat));
    }

    #[test]
    fn voice_grant_does_not_leak_to_chat() {
        let e = RightsEngine::new(RightsConfig {
            rules: Some(vec![RightsRule {
                name: None,
                r#match: RuleMatch {
                    server_groups: Some(vec!["100".into()]),
                    uids: None,
                },
                allow: Some(vec!["stop".into()]),
                deny: None,
                scope: Some(Scope::Voice),
            }]),
            ..Default::default()
        });
        assert!(e.can(&member(), "stop", Scope::Voice));
        assert!(!e.can(&member(), "stop", Scope::Chat));
    }

    #[test]
    fn is_rights_config_validates() {
        let good = serde_json::json!({
            "rules": [{"match": {"serverGroups": ["1"]}, "allow": ["play"], "scope": "voice"}]
        });
        assert!(is_rights_config(&good));
        assert!(!is_rights_config(&serde_json::Value::Null));
        assert!(!is_rights_config(&serde_json::json!({"rules": "bad"})));
        assert!(!is_rights_config(&serde_json::json!({"rules": [{"allow": [1]}]})));
    }

    #[test]
    fn nickname_match_is_exact() {
        assert!(nickname_matches_username("Bond", "bond"));
        assert!(!nickname_matches_username("Bond007", "bond"));
        assert!(!nickname_matches_username("", "bond"));
    }
}
