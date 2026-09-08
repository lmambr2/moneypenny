// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Org knowledge graph (`kg_facts`). Never mixed with per-user `user_memory`.

use serde::Serialize;

use crate::{Database, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KgFact {
    pub id: i64,
    pub subject: String,
    pub fact: String,
    pub valid_from: Option<String>,
    pub valid_until: Option<String>,
    pub diary: Option<String>,
    pub created_by_uid: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Default)]
pub struct KgDateFlags {
    pub text: String,
    pub from: Option<String>,
    pub until: Option<String>,
    pub as_of: Option<String>,
    pub diary: Option<String>,
}

pub struct KgStore<'a> {
    pub(crate) db: &'a Database,
}

impl KgStore<'_> {
    pub fn add(
        &self,
        fact: &str,
        subject: Option<&str>,
        valid_from: Option<&str>,
        valid_until: Option<&str>,
        diary: Option<&str>,
        created_by_uid: Option<&str>,
    ) -> Result<KgFact> {
        let fact = if fact.len() > 500 { &fact[..500] } else { fact };
        let subject = subject
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| extract_subject(fact));
        let subject = if subject.len() > 120 {
            subject[..120].to_string()
        } else {
            subject
        };
        let diary = diary.filter(|d| *d == "intel" || *d == "logistics");
        let now = now_ms();
        self.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO kg_facts (subject, fact, valid_from, valid_until, diary, created_by_uid, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    subject,
                    fact,
                    valid_from,
                    valid_until,
                    diary,
                    created_by_uid,
                    now
                ],
            )?;
            let id = conn.last_insert_rowid();
            Ok(KgFact {
                id,
                subject,
                fact: fact.to_string(),
                valid_from: valid_from.map(str::to_string),
                valid_until: valid_until.map(str::to_string),
                diary: diary.map(str::to_string),
                created_by_uid: created_by_uid.map(str::to_string),
                created_at: now,
            })
        })
    }

    pub fn list(&self, limit: u32) -> Result<Vec<KgFact>> {
        let limit = limit.clamp(1, 500);
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, subject, fact, valid_from, valid_until, diary, created_by_uid, created_at
                 FROM kg_facts ORDER BY created_at DESC, id DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(rusqlite::params![limit], row_to_fact)?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
    }

    pub fn count(&self) -> Result<u32> {
        self.db.with_conn(|conn| {
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM kg_facts", [], |r| r.get(0))?;
            Ok(n as u32)
        })
    }

    pub fn search_like(&self, needle: &str, limit: u32) -> Result<Vec<KgFact>> {
        let like = format!("%{needle}%");
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, subject, fact, valid_from, valid_until, diary, created_by_uid, created_at
                 FROM kg_facts
                 WHERE subject LIKE ?1 OR fact LIKE ?2
                 ORDER BY created_at DESC, id DESC LIMIT ?3",
            )?;
            let rows = stmt.query_map(rusqlite::params![like, like, limit], row_to_fact)?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
    }

    pub fn query_subject(&self, subject: &str, as_of: &str, limit: u32) -> Result<Vec<KgFact>> {
        let needle = subject.trim();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let ref_date = if as_of.trim().is_empty() {
            today_utc()
        } else {
            as_of.trim().to_string()
        };
        Ok(self
            .search_like(needle, limit.max(50))?
            .into_iter()
            .filter(|f| is_fact_active_at(f.valid_from.as_deref(), f.valid_until.as_deref(), &ref_date))
            .take(limit as usize)
            .collect())
    }

    pub fn search_text(&self, question: &str, as_of: Option<&str>, limit: u32) -> Result<Vec<KgFact>> {
        let tokens: Vec<String> = question
            .to_ascii_lowercase()
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|t| t.len() >= 3)
            .take(6)
            .map(str::to_string)
            .collect();
        let ref_date = as_of
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(today_utc);
        if tokens.is_empty() {
            return Ok(self
                .list(limit)?
                .into_iter()
                .filter(|f| is_fact_active_at(f.valid_from.as_deref(), f.valid_until.as_deref(), &ref_date))
                .collect());
        }
        let mut seen = std::collections::HashSet::new();
        let mut hits = Vec::new();
        for token in tokens {
            for f in self.search_like(&token, 30)? {
                if !seen.insert(f.id) {
                    continue;
                }
                if !is_fact_active_at(f.valid_from.as_deref(), f.valid_until.as_deref(), &ref_date) {
                    continue;
                }
                hits.push(f);
                if hits.len() >= limit as usize {
                    return Ok(hits);
                }
            }
        }
        Ok(hits)
    }

    pub fn forget_all(&self) -> Result<u32> {
        self.db.with_conn(|conn| {
            let n = conn.execute("DELETE FROM kg_facts", [])?;
            Ok(n as u32)
        })
    }

    pub fn forget_at_index(&self, index: i64) -> Result<bool> {
        if index < 1 {
            return Ok(false);
        }
        let rows = self.list(100)?;
        let Some(row) = rows.get((index - 1) as usize) else {
            return Ok(false);
        };
        let id = row.id;
        self.db.with_conn(|conn| {
            let n = conn.execute("DELETE FROM kg_facts WHERE id = ?1", rusqlite::params![id])?;
            Ok(n > 0)
        })
    }
}

pub fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let Ok(y) = s[0..4].parse::<i32>() else {
        return false;
    };
    let Ok(m) = s[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(d) = s[8..10].parse::<u32>() else {
        return false;
    };
    if !(1..=12).contains(&m) || d < 1 {
        return false;
    }
    let max = days_in_month(y, m);
    d <= max
}

pub fn parse_kg_flags(raw: &str) -> KgDateFlags {
    let mut text = raw.trim().to_string();
    let mut out = KgDateFlags {
        text: text.clone(),
        ..Default::default()
    };
    pull_flag(&mut text, "from:", |v| {
        if is_iso_date(&v) {
            out.from = Some(v);
        }
    });
    pull_flag(&mut text, "until:", |v| {
        if is_iso_date(&v) {
            out.until = Some(v);
        }
    });
    pull_flag(&mut text, "asof:", |v| {
        if is_iso_date(&v) {
            out.as_of = Some(v);
        }
    });
    pull_flag(&mut text, "diary:", |v| {
        let d = v.to_ascii_lowercase();
        if d == "intel" || d == "logistics" {
            out.diary = Some(d);
        }
    });
    out.text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    out
}

pub fn extract_subject(fact: &str) -> String {
    let t = fact.trim();
    if let Some(i) = find_ci(t, " was ") {
        return t[..i].trim().to_string();
    }
    if let Some(i) = find_ci(t, " held ") {
        return t[..i].trim().to_string();
    }
    if let Some(i) = find_ci(t, " is ") {
        let subj = t[..i].trim();
        if subj.split_whitespace().count() <= 4 {
            return subj.to_string();
        }
    }
    let words: Vec<&str> = t.split_whitespace().collect();
    if words.len() >= 2 {
        format!("{} {}", words[0], words[1])
    } else {
        words.first().copied().unwrap_or(t).chars().take(80).collect()
    }
}

pub fn is_fact_active_at(valid_from: Option<&str>, valid_until: Option<&str>, as_of: &str) -> bool {
    if !is_iso_date(as_of) {
        return true;
    }
    if let Some(from) = valid_from.filter(|s| is_iso_date(s)) {
        if as_of < from {
            return false;
        }
    }
    if let Some(until) = valid_until.filter(|s| is_iso_date(s)) {
        if as_of > until {
            return false;
        }
    }
    true
}

pub fn format_kg_record(
    subject: &str,
    fact: &str,
    valid_from: Option<&str>,
    valid_until: Option<&str>,
    diary: Option<&str>,
) -> String {
    let mut parts = vec![format!("@subject:{}", subject.trim())];
    if let Some(v) = valid_from.filter(|s| !s.is_empty()) {
        parts.push(format!("@from:{v}"));
    }
    if let Some(v) = valid_until.filter(|s| !s.is_empty()) {
        parts.push(format!("@until:{v}"));
    }
    if let Some(v) = diary.filter(|s| !s.is_empty()) {
        parts.push(format!("@diary:{v}"));
    }
    format!("{} | {}", parts.join(" "), fact.trim())
}

pub fn display_fact_line(fact: &str, valid_from: Option<&str>, valid_until: Option<&str>) -> String {
    let mut span = Vec::new();
    if let Some(v) = valid_from.filter(|s| !s.is_empty()) {
        span.push(format!("from {v}"));
    }
    if let Some(v) = valid_until.filter(|s| !s.is_empty()) {
        span.push(format!("until {v}"));
    }
    if span.is_empty() {
        fact.to_string()
    } else {
        format!("{fact} ({})", span.join(", "))
    }
}

fn pull_flag(text: &mut String, key: &str, mut assign: impl FnMut(String)) {
    let low = text.to_ascii_lowercase();
    let key_l = key.to_ascii_lowercase();
    let Some(pos) = low.find(&key_l) else {
        return;
    };
    if pos > 0 {
        let prev = text.as_bytes()[pos - 1];
        if !prev.is_ascii_whitespace() {
            return;
        }
    }
    let rest = &text[pos + key.len()..];
    let val: String = rest
        .chars()
        .take_while(|c| !c.is_whitespace())
        .collect();
    if val.is_empty() {
        return;
    }
    assign(val.clone());
    let end = pos + key.len() + val.len();
    let mut next = String::new();
    next.push_str(&text[..pos]);
    next.push_str(&text[end..]);
    *text = next;
}

fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    hay.to_ascii_lowercase().find(&needle.to_ascii_lowercase())
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

fn today_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86400;
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn row_to_fact(row: &rusqlite::Row<'_>) -> rusqlite::Result<KgFact> {
    let diary: Option<String> = row.get(5)?;
    let diary = diary.filter(|d| d == "intel" || d == "logistics");
    Ok(KgFact {
        id: row.get(0)?,
        subject: row.get(1)?,
        fact: row.get(2)?,
        valid_from: row.get(3)?,
        valid_until: row.get(4)?,
        diary,
        created_by_uid: row.get(6)?,
        created_at: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;

    #[test]
    fn add_list_forget() {
        let db = Database::open_in_memory().unwrap();
        db.kg()
            .add("Alice is the fleet commander", None, None, None, None, Some("u1"))
            .unwrap();
        let rows = db.kg().list(10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].subject, "Alice");
        assert!(db.kg().forget_at_index(1).unwrap());
        assert_eq!(db.kg().list(10).unwrap().len(), 0);
    }

    #[test]
    fn validity_window() {
        assert!(is_fact_active_at(Some("2026-01-01"), Some("2026-12-31"), "2026-06-01"));
        assert!(!is_fact_active_at(Some("2026-01-01"), Some("2026-03-01"), "2026-06-01"));
        assert!(is_iso_date("2026-09-07"));
        assert!(!is_iso_date("2026-13-01"));
    }

    #[test]
    fn flags_and_subject() {
        let p = parse_kg_flags("Alice is FC from:2026-01-01 until:2026-12-31");
        assert_eq!(p.text, "Alice is FC");
        assert_eq!(p.from.as_deref(), Some("2026-01-01"));
        assert_eq!(extract_subject("Alice is the fleet commander"), "Alice");
    }
}
