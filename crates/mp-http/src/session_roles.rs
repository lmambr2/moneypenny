// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Temporary `Session /` server groups. Clear only touches the allowlist.

pub const SESSION_USAGE: &str =
    "Usage: !session [status|clear|clear dry] — temporary Session / role groups (S-6 / mod).";

pub use mp_config::SessionRolesConfig;

pub fn filter_clearable(session_ids: &[i64], permanent: &[i64]) -> (Vec<i64>, Vec<i64>) {
    let mut clearable = Vec::new();
    let mut blocked = Vec::new();
    for id in session_ids {
        if *id <= 0 {
            continue;
        }
        if permanent.contains(id) {
            blocked.push(*id);
        } else {
            clearable.push(*id);
        }
    }
    (clearable, blocked)
}

pub fn format_session_status(cfg: &SessionRolesConfig, permanent: &[i64], query_up: bool) -> String {
    let (clearable, blocked) = filter_clearable(&cfg.group_ids, permanent);
    let ids = if cfg.group_ids.is_empty() {
        "(none — set sessionRoles.groupIds)".into()
    } else {
        cfg.group_ids
            .iter()
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let clear_s = if clearable.is_empty() {
        "—".into()
    } else {
        clearable.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(", ")
    };
    let mut lines = vec![
        format!("Session roles (temporary): prefix \"{}\"", cfg.name_prefix),
        format!("Configured group IDs: {ids}"),
        format!("Clearable: {clear_s}"),
    ];
    if !blocked.is_empty() {
        lines.push(format!(
            "Blocked (also permanent rights): {}",
            blocked.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(", ")
        ));
    }
    lines.push(format!(
        "Auto-clear on empty server: {}",
        if cfg.auto_clear_on_empty {
            format!("on ({} min grace)", cfg.clear_grace_minutes)
        } else {
            "off".into()
        }
    ));
    lines.push(format!(
        "HTTP Query: {}",
        if query_up { "available" } else { "unavailable (clear needs TS6 Query)" }
    ));
    lines.join("\n")
}

pub fn format_session_clear(
    clearable: &[i64],
    blocked: &[i64],
    dry_run: bool,
    query_up: bool,
    removed: usize,
    memberships: usize,
    errors: &[String],
) -> String {
    if clearable.is_empty() && blocked.is_empty() {
        return "No temporary session-role groups configured. Set sessionRoles.groupIds to the Session / … server-group IDs, then retry.".into();
    }
    if clearable.is_empty() {
        return format!(
            "Refusing clear: every sessionRoles.groupId is also a permanent rights group ({}). Fix the allowlist — session tags must not reuse rank IDs.",
            blocked.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(", ")
        );
    }
    if !query_up {
        return "Cannot clear session roles: TeamSpeak HTTP Query is not configured (TS6_QUERY_HOST / API key). Configure Query or clear groups manually in the TS client.".into();
    }
    let verb = if dry_run { "Would remove" } else { "Removed" };
    let mut lines = vec![format!(
        "{verb} {removed} membership{} across {} session group{} ({memberships} listed).",
        if removed == 1 { "" } else { "s" },
        clearable.len(),
        if clearable.len() == 1 { "" } else { "s" }
    )];
    if !blocked.is_empty() {
        lines.push(format!(
            "Skipped {} id(s) also used for permanent rights: {}.",
            blocked.len(),
            blocked.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(", ")
        ));
    }
    if !errors.is_empty() {
        lines.push(format!(
            "Errors ({}): {}",
            errors.len(),
            errors.iter().take(5).cloned().collect::<Vec<_>>().join("; ")
        ));
    }
    if dry_run {
        lines.push("Dry run — no changes applied.".into());
    }
    lines.join(" ")
}

pub trait SessionQuery: Send + Sync {
    fn list_members<'a>(
        &'a self,
        sgid: i64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<i64>, String>> + Send + 'a>>;
    fn remove_member<'a>(
        &'a self,
        sgid: i64,
        cldbid: i64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>;
}

pub struct SessionHandle {
    pub config: SessionRolesConfig,
    pub permanent: Vec<i64>,
    pub query: Option<std::sync::Arc<dyn SessionQuery>>,
    empty: std::sync::Mutex<EmptyServerClock>,
}

#[derive(Debug, Default)]
struct EmptyServerClock {
    since_ms: Option<u64>,
    last_fire_ms: u64,
    in_flight: bool,
}

impl SessionHandle {
    pub fn new(
        config: SessionRolesConfig,
        permanent: Vec<i64>,
        query: Option<std::sync::Arc<dyn SessionQuery>>,
    ) -> Self {
        Self {
            config,
            permanent,
            query,
            empty: std::sync::Mutex::new(EmptyServerClock::default()),
        }
    }

    pub fn from_bot_config(cfg: &mp_config::BotConfig, query: Option<std::sync::Arc<dyn SessionQuery>>) -> Self {
        Self::new(
            cfg.session_roles.clone(),
            permanent_rank_ids(cfg.rights.as_ref(), &cfg.admin_groups),
            query,
        )
    }

    /// Server-wide human count from the presence poll. Returns true once, when the
    /// empty-server grace has elapsed and a clear should run.
    pub fn note_server_humans(&self, humans: u32, now_ms: u64) -> bool {
        let mut clock = self.empty.lock().expect("session empty");
        let enabled = self.config.auto_clear_on_empty && !self.config.group_ids.is_empty();
        if !enabled || humans > 0 {
            clock.since_ms = None;
            return false;
        }
        let since = *clock.since_ms.get_or_insert(now_ms);
        let grace_ms = u64::from(self.config.clear_grace_minutes.max(1)) * 60_000;
        if now_ms.saturating_sub(since) < grace_ms {
            return false;
        }
        if clock.in_flight || now_ms.saturating_sub(clock.last_fire_ms) < 60_000 {
            return false;
        }
        clock.in_flight = true;
        clock.last_fire_ms = now_ms;
        true
    }

    pub async fn run_auto_clear(&self) -> String {
        let msg = handle_session("clear", &self.config, &self.permanent, self.query.as_deref()).await;
        let mut clock = self.empty.lock().expect("session empty");
        clock.in_flight = false;
        clock.since_ms = None;
        msg
    }
}

/// Rank ids that `!session clear` must never strip. Admin groups plus every
/// `rules[].match.serverGroups` entry, same as Node `permanentRankIdsFromRights`.
pub fn permanent_rank_ids(rights: Option<&serde_json::Value>, admin_groups: &[i32]) -> Vec<i64> {
    let mut ids = std::collections::BTreeSet::new();
    for g in admin_groups {
        if *g > 0 {
            ids.insert(i64::from(*g));
        }
    }
    // Node walks `rules[].match.serverGroups` directly. A schema rejection
    // (numeric ids, an unknown scope) must not drop those ranks.
    let Some(rules) = rights.and_then(|raw| raw.get("rules")).and_then(|r| r.as_array()) else {
        return ids.into_iter().collect();
    };
    for rule in rules {
        let Some(groups) = rule
            .get("match")
            .and_then(|m| m.get("serverGroups"))
            .and_then(|g| g.as_array())
        else {
            continue;
        };
        for g in groups {
            if let Some(n) = sgid_from_json(g) {
                ids.insert(n);
            }
        }
    }
    ids.into_iter().collect()
}

fn sgid_from_json(v: &serde_json::Value) -> Option<i64> {
    if let Some(s) = v.as_str() {
        return parse_sgid(s);
    }
    if let Some(n) = v.as_i64() {
        return (n > 0).then_some(n);
    }
    if let Some(n) = v.as_u64() {
        if n > 0 && n <= i64::MAX as u64 {
            return Some(n as i64);
        }
        return None;
    }
    let n = v.as_f64()?;
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    let trunc = n.trunc();
    if trunc >= i64::MAX as f64 {
        return None;
    }
    let i = trunc as i64;
    (i > 0).then_some(i)
}

fn parse_sgid(raw: &str) -> Option<i64> {
    let s = raw.trim();
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let mut i = 0usize;
    if bytes[0] == b'+' || bytes[0] == b'-' {
        i = 1;
    }
    if i >= bytes.len() || !bytes[i].is_ascii_digit() {
        return None;
    }
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    s[..i].parse::<i64>().ok().filter(|n| *n > 0)
}

pub async fn handle_session(
    args: &str,
    cfg: &SessionRolesConfig,
    permanent: &[i64],
    query: Option<&dyn SessionQuery>,
) -> String {
    let parts: Vec<&str> = args.split_whitespace().collect();
    let sub = parts.first().copied().unwrap_or("status").to_ascii_lowercase();
    let query_up = query.is_some();
    if sub == "status" || sub == "list" || sub == "show" {
        return format_session_status(cfg, permanent, query_up);
    }
    if sub == "clear" || sub == "end" || sub == "reset" {
        let dry = parts.iter().any(|p| {
            let p = p.to_ascii_lowercase();
            p == "dry" || p == "dryrun" || p == "--dry" || p == "-n"
        });
        let (clearable, blocked) = filter_clearable(&cfg.group_ids, permanent);
        if clearable.is_empty() || query.is_none() {
            return format_session_clear(&clearable, &blocked, dry, query_up, 0, 0, &[]);
        }
        let query = query.unwrap();
        let mut removed = 0usize;
        let mut memberships = 0usize;
        let mut errors = Vec::new();
        for sgid in &clearable {
            match query.list_members(*sgid).await {
                Ok(ids) => {
                    memberships += ids.len();
                    for cldbid in ids {
                        if dry {
                            removed += 1;
                            continue;
                        }
                        match query.remove_member(*sgid, cldbid).await {
                            Ok(()) => removed += 1,
                            Err(e) => errors.push(format!("sgid {sgid} cldbid {cldbid}: {e}")),
                        }
                    }
                }
                Err(e) => errors.push(format!("sgid {sgid}: {e}")),
            }
        }
        return format_session_clear(
            &clearable,
            &blocked,
            dry,
            true,
            removed,
            memberships,
            &errors,
        );
    }
    SESSION_USAGE.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn status_and_clear_without_query() {
        let cfg = SessionRolesConfig {
            group_ids: vec![10, 2],
            ..SessionRolesConfig::default()
        };
        let status = handle_session("status", &cfg, &[2], None).await;
        assert!(status.contains("prefix \"Session /\""), "{status}");
        assert!(status.contains("10, 2") || status.contains("10"), "{status}");
        assert!(status.contains("Blocked"), "{status}");
        let clear = handle_session("clear dry", &cfg, &[2], None).await;
        assert!(clear.contains("HTTP Query") || clear.contains("not configured"), "{clear}");
    }

    #[tokio::test]
    async fn refuses_when_every_id_is_a_rank_group() {
        let cfg = SessionRolesConfig {
            group_ids: vec![2],
            ..SessionRolesConfig::default()
        };
        let msg = handle_session("clear", &cfg, &[2], Some(&EmptyQuery)).await;
        assert!(msg.contains("Refusing clear"), "{msg}");
    }

    #[test]
    fn auto_clear_fires_only_after_the_grace_and_resets_when_someone_returns() {
        let handle = SessionHandle::new(
            SessionRolesConfig {
                group_ids: vec![201],
                auto_clear_on_empty: true,
                clear_grace_minutes: 15,
                ..SessionRolesConfig::default()
            },
            Vec::new(),
            None,
        );
        assert!(!handle.note_server_humans(0, 0));
        assert!(!handle.note_server_humans(0, 14 * 60_000));
        assert!(!handle.note_server_humans(2, 16 * 60_000));
        assert!(!handle.note_server_humans(0, 16 * 60_000));
        assert!(handle.note_server_humans(0, 16 * 60_000 + 15 * 60_000));
        assert!(!handle.note_server_humans(0, 16 * 60_000 + 15 * 60_000 + 1_000));
    }

    struct EmptyQuery;
    impl SessionQuery for EmptyQuery {
        fn list_members<'a>(
            &'a self,
            _sgid: i64,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<i64>, String>> + Send + 'a>>
        {
            Box::pin(async { Ok(Vec::new()) })
        }
        fn remove_member<'a>(
            &'a self,
            _sgid: i64,
            _cldbid: i64,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>>
        {
            Box::pin(async { Ok(()) })
        }
    }
}
