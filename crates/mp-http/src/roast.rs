// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Roast capture / grade / reel. LLM grading is never on the skip path.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use mp_brain::BrainRuntime;
use mp_db::{Database, RoastQuote};

pub const ROAST_REEL_SIZE: usize = 5;
pub const ROAST_MIN_GRADED_FOR_AUTO: u32 = 3;
pub const ROAST_MAX_PER_USER: usize = 2;
pub const ROAST_DEDUPE_WINDOW_MS: i64 = 5 * 60_000;

#[derive(Debug, Clone)]
pub struct RoastConfig {
    pub enabled: bool,
    pub min_present: u32,
    pub cooldown_minutes: u32,
    pub min_score: i64,
    pub prefix: String,
}

impl RoastConfig {
    pub fn from_bot(c: &mp_config::BotConfig) -> Self {
        Self {
            enabled: c.roast_enabled,
            min_present: c.roast_min_present.max(1),
            cooldown_minutes: c.roast_cooldown_minutes,
            min_score: c.roast_min_score.clamp(0, 10),
            prefix: c.command_prefix.clone(),
        }
    }
}

pub struct RoastRuntime {
    db: Arc<Database>,
    brain: Arc<BrainRuntime>,
    cfg: RwLock<RoastConfig>,
    last_roast_at: AtomicI64,
    compiling: AtomicBool,
}

impl RoastRuntime {
    pub fn new(db: Arc<Database>, brain: Arc<BrainRuntime>, cfg: RoastConfig) -> Arc<Self> {
        let last = db.roast().last_roast_at().unwrap_or(0);
        Arc::new(Self {
            db,
            brain,
            cfg: RwLock::new(cfg),
            last_roast_at: AtomicI64::new(last),
            compiling: AtomicBool::new(false),
        })
    }

    pub fn config(&self) -> RoastConfig {
        self.cfg.read().expect("roast cfg").clone()
    }

    pub fn apply(&self, next: RoastConfig) {
        *self.cfg.write().expect("roast cfg") = next;
    }

    pub fn enabled(&self) -> bool {
        self.cfg.read().expect("roast cfg").enabled
    }

    /// Channel text only. Skip PMs, commands, opted-out, short/spam. Never on skip.
    pub fn capture_line(&self, uid: &str, name: &str, body: &str, is_pm: bool) {
        if is_pm {
            return;
        }
        let cfg = self.config();
        if !cfg.enabled {
            return;
        }
        if uid.is_empty() {
            return;
        }
        let text = sanitize_roast_capture(body);
        if text.len() < 3 {
            return;
        }
        if text.starts_with(&cfg.prefix) {
            return;
        }
        let store = self.db.roast();
        if store.is_opted_out(uid).unwrap_or(false) {
            return;
        }
        if store
            .has_recent_duplicate(uid, &text, ROAST_DEDUPE_WINDOW_MS)
            .unwrap_or(false)
        {
            return;
        }
        let _ = store.add(uid, if name.is_empty() { "someone" } else { name }, &text);
    }

    pub async fn handle_command(&self) -> String {
        let cfg = self.config();
        if !cfg.enabled {
            return "The roast is switched off. An admin can enable it in Settings.".into();
        }
        if let Some(reel) = self.build_reel() {
            return reel;
        }
        let stats = self.db.roast().stats(cfg.min_score).unwrap_or((0, 0, 0));
        let (pending, graded, high) = stats;
        if pending > 0 {
            return format!(
                "Nothing roast-worthy graded yet — {pending} line{} still in the queue{}.",
                if pending == 1 { "" } else { "s" },
                if high > 0 {
                    format!(" ({high} already ≥{})", cfg.min_score)
                } else {
                    String::new()
                }
            );
        }
        if high == 0 {
            return format!(
                "Nothing scored {}+ yet — keep chatting{}.",
                cfg.min_score,
                if graded > 0 {
                    format!(" ({graded} graded under the bar)")
                } else {
                    String::new()
                }
            );
        }
        let remain = cooldown_remaining_ms(self.last_roast_at.load(Ordering::SeqCst), cfg.cooldown_minutes);
        if remain > 0 {
            let mins = (remain + 59_999) / 60_000;
            return format!(
                "No reel ready (need score ≥{}). Next auto reel in ~{mins} min.",
                cfg.min_score
            );
        }
        "Nothing roast-worthy graded yet — give it time.".into()
    }

    pub fn handle_opt_out(&self, uid: &str) -> String {
        if uid.is_empty() || uid.starts_with("clid:") {
            return "Couldn't identify you — opt-out not applied.".into();
        }
        let n = self.db.roast().opt_out(uid).unwrap_or(0);
        format!(
            "You're out of the roast. Purged {n} captured line{} and stopped recording you. Use !roastin to rejoin.",
            if n == 1 { "" } else { "s" }
        )
    }

    pub fn handle_opt_in(&self, uid: &str) -> String {
        if uid.is_empty() || uid.starts_with("clid:") {
            return "Couldn't identify you — opt-in not applied.".into();
        }
        if !self.db.roast().is_opted_out(uid).unwrap_or(false) {
            return "You're already in the roast — keep chatting (or !roastout to leave).".into();
        }
        let _ = self.db.roast().opt_in(uid);
        "Welcome back to the roast. New lines will be captured; purged history stays gone.".into()
    }

    pub fn build_reel(&self) -> Option<String> {
        let cfg = self.config();
        let picks = select_reel_quotes(
            &self.db.roast().top(40).unwrap_or_default(),
            ROAST_REEL_SIZE,
            cfg.min_score,
            ROAST_MAX_PER_USER,
        );
        format_roast_reel(&picks)
    }

    /// Idle tick: grade a batch, maybe return a reel to post. Never blocks skip.
    pub async fn run_tick(&self, human_count: u32) -> Option<String> {
        if !self.enabled() {
            return None;
        }
        if self
            .compiling
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return None;
        }
        let out = self.grade_and_maybe_reel(human_count).await;
        self.compiling.store(false, Ordering::SeqCst);
        out
    }

    async fn grade_and_maybe_reel(&self, human_count: u32) -> Option<String> {
        self.grade_batch().await;
        let cfg = self.config();
        if human_count < cfg.min_present {
            return None;
        }
        let high = self.db.roast().graded_count(cfg.min_score).unwrap_or(0);
        if high < ROAST_MIN_GRADED_FOR_AUTO {
            return None;
        }
        let remain = cooldown_remaining_ms(self.last_roast_at.load(Ordering::SeqCst), cfg.cooldown_minutes);
        if remain > 0 {
            return None;
        }
        let picks = select_reel_quotes(
            &self.db.roast().top(40).unwrap_or_default(),
            ROAST_REEL_SIZE,
            cfg.min_score,
            ROAST_MAX_PER_USER,
        );
        let reel = format_roast_reel(&picks)?;
        let ids: Vec<i64> = picks.iter().map(|q| q.id).collect();
        let now = now_ms();
        self.last_roast_at.store(now, Ordering::SeqCst);
        let _ = self.db.roast().set_last_roast_at(now);
        let _ = self.db.roast().remove_by_ids(&ids);
        Some(reel)
    }

    async fn grade_batch(&self) {
        let batch = self.db.roast().ungraded(5).unwrap_or_default();
        if batch.is_empty() {
            return;
        }
        let system = "You are a ruthless but witty roast judge. Score how cringe or embarrassing \
a single chat line is, from 0 (forgettable) to 10 (maximally cringe). Reply \
with ONLY a JSON object: {\"score\": <integer 0-10>, \"reason\": \"<short reason>\"}.";
        for q in batch {
            if looks_like_image_or_binary(&q.text) {
                let _ = self.db.roast().set_grade(q.id, 0, "non-text (image/binary)");
                continue;
            }
            let user = format!("Chat line from {}: {}", q.user_name, serde_json::json!(q.text));
            let Some(out) = self.brain.complete_plain(system, &user).await else {
                continue;
            };
            if let Some(g) = parse_roast_grade(&out) {
                let _ = self.db.roast().set_grade(q.id, g.score, &g.reason);
            } else {
                let _ = self.db.roast().set_grade(q.id, 0, "ungradeable");
            }
        }
    }
}

pub struct RoastGrade {
    pub score: i64,
    pub reason: String,
}

pub fn parse_roast_grade(raw: &str) -> Option<RoastGrade> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&raw[start..=end]).ok()?;
    let score = v.get("score")?.as_i64().or_else(|| v.get("score")?.as_f64().map(|n| n as i64))?;
    let reason = v
        .get("reason")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .chars()
        .take(280)
        .collect();
    Some(RoastGrade { score, reason })
}

pub fn select_reel_quotes(
    quotes: &[RoastQuote],
    limit: usize,
    min_score: i64,
    max_per_user: usize,
) -> Vec<RoastQuote> {
    let mut sorted: Vec<RoastQuote> = quotes
        .iter()
        .filter(|q| q.score.unwrap_or(-1) >= min_score)
        .cloned()
        .collect();
    sorted.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(b.created_at.cmp(&a.created_at))
    });
    let mut picked = Vec::new();
    let mut per_user: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for q in sorted {
        let n = per_user.get(&q.user_uid).copied().unwrap_or(0);
        if n >= max_per_user {
            continue;
        }
        per_user.insert(q.user_uid.clone(), n + 1);
        picked.push(q);
        if picked.len() >= limit {
            break;
        }
    }
    picked
}

pub fn format_roast_reel(quotes: &[RoastQuote]) -> Option<String> {
    if quotes.is_empty() {
        return None;
    }
    let lines: Vec<String> = quotes
        .iter()
        .enumerate()
        .map(|(i, q)| {
            let reason = q
                .reason
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(|s| format!(" — {s}"))
                .unwrap_or_default();
            format!(
                "{}. {} ({}/10): \"{}\"{reason}",
                i + 1,
                q.user_name,
                q.score.unwrap_or(0),
                q.text
            )
        })
        .collect();
    Some(format!(
        "🔥 Roast reel — today's greatest hits 🔥\n{}",
        lines.join("\n")
    ))
}

pub fn cooldown_remaining_ms(last_roast_at: i64, cooldown_minutes: u32) -> i64 {
    let cooldown_ms = i64::from(cooldown_minutes) * 60_000;
    (cooldown_ms - (now_ms() - last_roast_at)).max(0)
}

pub fn looks_like_image_or_binary(raw: &str) -> bool {
    let s = raw.replace("\r\n", "\n").trim().to_string();
    if s.is_empty() {
        return false;
    }
    let lower = s.to_ascii_lowercase();
    if lower.contains("data:image/") || lower.contains("[img") {
        return true;
    }
    let compact: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    let b64 = compact
        .split("base64,")
        .last()
        .unwrap_or(&compact)
        .to_string();
    if b64.starts_with("iVBORw0KGgo")
        || b64.starts_with("/9j/")
        || b64.starts_with("R0lGOD")
        || b64.starts_with("UklGR")
    {
        return true;
    }
    if b64.len() >= 80 {
        let b64_chars = b64
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/' || *c == '=')
            .count();
        if b64_chars * 100 / b64.len() >= 92 {
            let spaces = s.chars().filter(|c| c.is_whitespace()).count();
            let words = s
                .split_whitespace()
                .filter(|w| w.chars().filter(|c| c.is_ascii_alphabetic()).count() >= 3)
                .count();
            if spaces * 100 / s.len().max(1) < 6 && words < 4 {
                return true;
            }
        }
    }
    false
}

pub fn sanitize_roast_capture(raw: &str) -> String {
    sanitize_roast_capture_len(raw, 400)
}

pub fn sanitize_roast_capture_len(raw: &str, max_len: usize) -> String {
    if looks_like_image_or_binary(raw) {
        return String::new();
    }
    let mut t = raw.replace("\r\n", "\n");
    t = strip_bbcode_and_urls(&t);
    t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if looks_like_image_or_binary(&t) {
        return String::new();
    }
    if t.len() > max_len {
        t.truncate(max_len);
        t = t.trim_end().to_string();
    }
    t
}

fn strip_bbcode_and_urls(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'[' {
            if let Some(end) = s[i..].find(']') {
                i += end + 1;
                continue;
            }
        }
        if s[i..].starts_with("http://") || s[i..].starts_with("https://") {
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            continue;
        }
        out.push(s[i..].chars().next().unwrap_or(' '));
        i += s[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
    }
    out
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_grade_json() {
        let g = parse_roast_grade("sure {\"score\": 8, \"reason\": \"yikes\"} extra").unwrap();
        assert_eq!(g.score, 8);
        assert_eq!(g.reason, "yikes");
    }

    #[test]
    fn sanitize_drops_commands_and_images() {
        assert!(sanitize_roast_capture("data:image/png;base64,AAAA").is_empty());
        let t = sanitize_roast_capture("[b]hello[/b] https://x.test world");
        assert!(t.contains("hello"));
        assert!(t.contains("world"));
        assert!(!t.contains("http"));
    }

    #[test]
    fn reel_diversity() {
        let q = |uid: &str, score: i64| RoastQuote {
            id: score,
            user_uid: uid.into(),
            user_name: uid.into(),
            text: "line".into(),
            created_at: score,
            score: Some(score),
            reason: None,
        };
        let picks = select_reel_quotes(
            &[q("a", 9), q("a", 8), q("a", 7), q("b", 6)],
            5,
            4,
            2,
        );
        assert_eq!(picks.len(), 3);
        assert_eq!(picks.iter().filter(|x| x.user_uid == "a").count(), 2);
    }
}
