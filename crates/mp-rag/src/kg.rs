// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Org KG commands + MemPalace sync. SQLite is authority; never per-user rooms.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use mp_db::{
    display_fact_line, extract_subject, format_kg_record, is_iso_date, parse_kg_flags, Database,
    KgFact,
};

use crate::mempalace::MemPalaceClient;

pub const KG_USAGE: &str = "Usage: !kg remember <fact> [from:YYYY-MM-DD] [until:YYYY-MM-DD] | \
!kg who <name> [asof:YYYY-MM-DD] | !kg list [n] | !kg forget <n|all>";

pub const DIARY_USAGE: &str = "Usage: !diary <intel|logistics> <fact> [from:YYYY-MM-DD] [until:YYYY-MM-DD]";

pub struct KgService {
    db: Arc<Database>,
    kg_enabled: AtomicBool,
    mempalace_enabled: AtomicBool,
    mempalace: std::sync::Mutex<Option<MemPalaceClient>>,
}

impl KgService {
    pub fn new(db: Arc<Database>) -> Arc<Self> {
        Arc::new(Self {
            db,
            kg_enabled: AtomicBool::new(false),
            mempalace_enabled: AtomicBool::new(false),
            mempalace: std::sync::Mutex::new(None),
        })
    }

    pub fn set_kg_enabled(&self, v: bool) {
        self.kg_enabled.store(v, Ordering::SeqCst);
    }

    pub fn kg_enabled(&self) -> bool {
        self.kg_enabled.load(Ordering::SeqCst)
    }

    pub fn set_mempalace(&self, client: Option<MemPalaceClient>, enabled: bool) {
        *self.mempalace.lock().expect("kg mp") = client;
        self.mempalace_enabled.store(enabled, Ordering::SeqCst);
    }

    fn use_mempalace(&self) -> Option<MemPalaceClient> {
        if !self.mempalace_enabled.load(Ordering::SeqCst) {
            return None;
        }
        self.mempalace.lock().ok().and_then(|g| g.clone())
    }

    pub fn handle_kg(&self, args: &str, invoker_uid: Option<&str>, can_write: bool) -> String {
        let trimmed = args.trim();
        if trimmed.is_empty() {
            return KG_USAGE.into();
        }
        let (sub, rest) = split_sub(trimmed);
        match sub {
            "remember" => self.handle_remember(rest, invoker_uid, None, can_write),
            "who" => self.handle_who(rest),
            "list" => self.handle_list(rest),
            "forget" => self.handle_forget(rest, can_write),
            _ => KG_USAGE.into(),
        }
    }

    pub fn handle_diary(&self, args: &str, invoker_uid: Option<&str>, can_write: bool) -> String {
        if !can_write {
            return "Diary entries require analyst rights (@analyst).".into();
        }
        let trimmed = args.trim();
        let Some((diary, rest)) = trimmed.split_once(|c: char| c.is_whitespace()) else {
            return DIARY_USAGE.into();
        };
        let diary = diary.to_ascii_lowercase();
        if diary != "intel" && diary != "logistics" {
            return DIARY_USAGE.into();
        }
        self.handle_remember(rest.trim(), invoker_uid, Some(&diary), can_write)
    }

    fn handle_remember(
        &self,
        raw: &str,
        invoker_uid: Option<&str>,
        diary: Option<&str>,
        can_write: bool,
    ) -> String {
        if !can_write {
            return "Recording org facts requires analyst rights (@analyst).".into();
        }
        let parsed = parse_kg_flags(raw);
        let fact = parsed.text;
        if fact.is_empty() {
            return if diary.is_some() {
                DIARY_USAGE.into()
            } else {
                "Usage: !kg remember <fact> [from:YYYY-MM-DD] [until:YYYY-MM-DD]".into()
            };
        }
        if parsed.from.as_ref().is_some_and(|s| !is_iso_date(s)) {
            return "Invalid from: date — use YYYY-MM-DD.".into();
        }
        if parsed.until.as_ref().is_some_and(|s| !is_iso_date(s)) {
            return "Invalid until: date — use YYYY-MM-DD.".into();
        }
        let subject = extract_subject(&fact);
        let diary_tag = diary
            .map(str::to_string)
            .or(parsed.diary);
        let row = match self.db.kg().add(
            &fact,
            Some(&subject),
            parsed.from.as_deref(),
            parsed.until.as_deref(),
            diary_tag.as_deref(),
            invoker_uid,
        ) {
            Ok(r) => r,
            Err(e) => return format!("Couldn't save that: {e}"),
        };
        if let Some(mp) = self.use_mempalace() {
            let line = format_kg_record(
                &row.subject,
                &row.fact,
                row.valid_from.as_deref(),
                row.valid_until.as_deref(),
                row.diary.as_deref(),
            );
            let subject = row.subject.clone();
            let vf = row.valid_from.clone().unwrap_or_default();
            let vu = row.valid_until.clone().unwrap_or_default();
            let diary = row.diary.clone().unwrap_or_default();
            tokio::spawn(async move {
                if !mp
                    .kg_remember(&line, &subject, &vf, &vu, &diary)
                    .await
                {
                    tracing::warn!(subject, "MemPalace KG sync failed — SQLite kept");
                }
            });
        }
        let label = diary_tag
            .as_deref()
            .map(|d| format!("{d} diary"))
            .unwrap_or_else(|| "org KG".into());
        format!(
            "Recorded in {label}: {}",
            display_fact_line(&row.fact, row.valid_from.as_deref(), row.valid_until.as_deref())
        )
    }

    fn handle_who(&self, raw: &str) -> String {
        let parsed = parse_kg_flags(raw);
        let subject = parsed.text;
        if subject.is_empty() {
            return "Usage: !kg who <name or role> [asof:YYYY-MM-DD]".into();
        }
        if parsed.as_of.as_ref().is_some_and(|s| !is_iso_date(s)) {
            return "Invalid asof: date — use YYYY-MM-DD.".into();
        }
        let as_of = parsed
            .as_of
            .clone()
            .unwrap_or_else(|| chrono_today());
        let facts = self
            .db
            .kg()
            .query_subject(&subject, &as_of, 15)
            .unwrap_or_default();
        if facts.is_empty() {
            return format!("No org records for \"{subject}\" as of {as_of}.");
        }
        let lines = facts
            .iter()
            .enumerate()
            .map(|(i, f)| {
                let mut line = format!(
                    "{}. {}",
                    i + 1,
                    display_fact_line(&f.fact, f.valid_from.as_deref(), f.valid_until.as_deref())
                );
                if let Some(d) = &f.diary {
                    line.push_str(&format!(" [{d}]"));
                }
                line
            })
            .collect::<Vec<_>>();
        format!("Org knowledge as of {as_of} for \"{subject}\":\n{}", lines.join("\n"))
    }

    fn handle_list(&self, raw: &str) -> String {
        let limit = raw
            .trim()
            .parse::<u32>()
            .ok()
            .map(|n| n.clamp(1, 30))
            .unwrap_or(15);
        let facts = self.db.kg().list(limit).unwrap_or_default();
        if facts.is_empty() {
            return "Org knowledge graph is empty. Analysts: !kg remember <fact>.".into();
        }
        let lines = facts
            .iter()
            .enumerate()
            .map(|(i, f)| {
                let mut line = format!(
                    "{}. {}",
                    i + 1,
                    display_fact_line(&f.fact, f.valid_from.as_deref(), f.valid_until.as_deref())
                );
                if let Some(d) = &f.diary {
                    line.push_str(&format!(" [{d}]"));
                }
                line
            })
            .collect::<Vec<_>>();
        format!("Recent org knowledge ({}):\n{}", facts.len(), lines.join("\n"))
    }

    fn handle_forget(&self, raw: &str, can_write: bool) -> String {
        if !can_write {
            return "Forgetting org facts requires analyst rights (@analyst).".into();
        }
        let trimmed = raw.trim().to_ascii_lowercase();
        if trimmed == "all" {
            let n = self.db.kg().forget_all().unwrap_or(0);
            return if n > 0 {
                format!("Purged {n} org fact{}.", if n == 1 { "" } else { "s" })
            } else {
                "Nothing to forget.".into()
            };
        }
        let Ok(index) = trimmed.parse::<i64>() else {
            return "Usage: !kg forget <number> (from !kg list) or !kg forget all".into();
        };
        if index < 1 {
            return "Usage: !kg forget <number> (from !kg list) or !kg forget all".into();
        }
        if self.db.kg().forget_at_index(index).unwrap_or(false) {
            "Forgotten.".into()
        } else {
            "No fact at that number — run !kg list.".into()
        }
    }

    /// MemPalace kgSearch first, then SQLite. Never private !remember rooms.
    pub async fn search_org(&self, query: &str, limit: u32) -> Vec<String> {
        let q = query.trim();
        if q.is_empty() {
            return Vec::new();
        }
        if let Some(mp) = self.use_mempalace() {
            let hits = mp.kg_search(q, limit).await;
            if !hits.is_empty() {
                return hits;
            }
        }
        if !self.kg_enabled() {
            return Vec::new();
        }
        self.db
            .kg()
            .search_text(q, None, limit)
            .unwrap_or_default()
            .into_iter()
            .map(|f| display_fact_line(&f.fact, f.valid_from.as_deref(), f.valid_until.as_deref()))
            .collect()
    }

    pub fn list_facts(&self, limit: u32) -> Vec<KgFact> {
        self.db.kg().list(limit).unwrap_or_default()
    }

    pub fn count(&self) -> u32 {
        self.db.kg().count().unwrap_or(0)
    }

    pub async fn seed_org_fact(
        &self,
        fact: &str,
        invoker_uid: Option<&str>,
    ) -> (bool, String, bool) {
        let msg = self.handle_remember(fact, invoker_uid, None, true);
        if msg.starts_with("Usage:") || msg.starts_with("Recording org") {
            return (false, msg, false);
        }
        let mut synced = false;
        if let Some(mp) = self.use_mempalace() {
            if let Some(row) = self.db.kg().list(1).ok().and_then(|v| v.into_iter().next()) {
                let line = format_kg_record(
                    &row.subject,
                    &row.fact,
                    row.valid_from.as_deref(),
                    row.valid_until.as_deref(),
                    row.diary.as_deref(),
                );
                synced = mp
                    .kg_remember(
                        &line,
                        &row.subject,
                        row.valid_from.as_deref().unwrap_or(""),
                        row.valid_until.as_deref().unwrap_or(""),
                        row.diary.as_deref().unwrap_or(""),
                    )
                    .await;
            }
        }
        (true, msg, synced)
    }

    pub async fn recall_for_question(&self, question: &str) -> Vec<(String, String)> {
        if !self.kg_enabled() {
            return Vec::new();
        }
        let as_of = question
            .to_ascii_lowercase()
            .split("as of ")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .filter(|s| is_iso_date(s))
            .map(str::to_string);
        if let Some(mp) = self.use_mempalace() {
            let hits = mp.kg_search(question, 8).await;
            if !hits.is_empty() {
                return hits
                    .into_iter()
                    .map(|f| (f, "org knowledge graph".into()))
                    .collect();
            }
        }
        self.db
            .kg()
            .search_text(question, as_of.as_deref(), 8)
            .unwrap_or_default()
            .into_iter()
            .map(|f| {
                let src = f
                    .diary
                    .as_deref()
                    .map(|d| format!("org memory ({d})"))
                    .unwrap_or_else(|| "org knowledge graph".into());
                (
                    display_fact_line(&f.fact, f.valid_from.as_deref(), f.valid_until.as_deref()),
                    src,
                )
            })
            .collect()
    }
}

fn split_sub(trimmed: &str) -> (&str, &str) {
    match trimmed.split_once(|c: char| c.is_whitespace()) {
        Some((a, b)) => (a, b.trim()),
        None => (trimmed, ""),
    }
}

fn chrono_today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86400) as i64;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remember_and_list() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let kg = KgService::new(db);
        let msg = kg.handle_kg("remember Alice is the fleet commander", Some("u1"), true);
        assert!(msg.contains("Recorded in org KG"), "{msg}");
        let list = kg.handle_kg("list", None, true);
        assert!(list.contains("Alice is the fleet commander"), "{list}");
        let who = kg.handle_kg("who Alice", None, true);
        assert!(who.contains("fleet commander"), "{who}");
    }

    #[test]
    fn write_requires_analyst() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let kg = KgService::new(db);
        let msg = kg.handle_kg("remember secret", Some("u1"), false);
        assert!(msg.contains("analyst"), "{msg}");
    }
}
