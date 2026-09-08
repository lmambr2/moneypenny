// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Normalize doctrine markdown for heading-aware RAG chunks.

const SKIP_SUFFIXES: &[&str] = &["ops/rag-ingestion-cheatsheet.md", "ops-rank-gating.md"];

pub fn should_skip_doctrine_reformat(source: &str) -> bool {
    let posix = source.replace('\\', "/");
    SKIP_SUFFIXES.iter().any(|s| posix.ends_with(s))
}

/// Returns Some(new text) when the file should be rewritten; None if unchanged/skip.
pub fn reformat_doctrine_markdown(raw: &str, source_name: &str) -> Option<String> {
    if should_skip_doctrine_reformat(source_name) {
        return None;
    }
    let old = raw.replace("\r\n", "\n").trim_start_matches('\u{feff}').to_string();
    let (mut classification, tags, valid_until, body) = split_frontmatter(&old);
    if classification.trim().is_empty() {
        classification = "unclassified".into();
    }
    let mut new_body = collapse_blank_lines(body.trim_start());
    if !new_body.lines().any(|l| l.trim_start().starts_with("# ")) {
        let title = source_name
            .replace('\\', "/")
            .split('/')
            .next_back()
            .unwrap_or(source_name)
            .trim_end_matches(".md")
            .trim_end_matches(".markdown")
            .replace(['-', '_'], " ");
        new_body = format!("# {title}\n\n{new_body}");
    }
    let mut fm = format!("---\nclassification: {classification}\n");
    if !tags.is_empty() {
        fm.push_str(&format!("tags: {tags}\n"));
    }
    if !valid_until.is_empty() {
        fm.push_str(&format!("valid_until: {valid_until}\n"));
    }
    fm.push_str("---\n\n");
    let new_text = format!("{fm}{new_body}");
    let new_text = if new_text.ends_with('\n') {
        new_text
    } else {
        format!("{new_text}\n")
    };
    if new_text == old {
        None
    } else {
        Some(new_text)
    }
}

fn split_frontmatter(raw: &str) -> (String, String, String, String) {
    let t = raw.trim_start();
    if !t.starts_with("---") {
        return (String::new(), String::new(), String::new(), raw.to_string());
    }
    let rest = t.trim_start_matches("---");
    let rest = rest.strip_prefix('\n').unwrap_or(rest);
    if let Some(end) = rest.find("\n---") {
        let fm = &rest[..end];
        let body = rest[end + 4..].trim_start_matches('\n').to_string();
        let mut classification = String::new();
        let mut tags = String::new();
        let mut valid_until = String::new();
        for line in fm.lines() {
            if let Some((k, v)) = line.split_once(':') {
                let key = k.trim().to_ascii_lowercase();
                let val = v.trim().to_string();
                match key.as_str() {
                    "classification" => classification = val,
                    "tags" => tags = val,
                    "valid_until" | "validuntil" => valid_until = val,
                    _ => {}
                }
            }
        }
        (classification, tags, valid_until, body)
    } else {
        (String::new(), String::new(), String::new(), raw.to_string())
    }
}

fn collapse_blank_lines(s: &str) -> String {
    let mut out = String::new();
    let mut blanks = 0u32;
    for line in s.lines() {
        if line.trim().is_empty() {
            blanks += 1;
            if blanks <= 2 {
                out.push('\n');
            }
        } else {
            blanks = 0;
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_classification_and_title() {
        let out = reformat_doctrine_markdown("hello world", "combat.md").unwrap();
        assert!(out.contains("classification: unclassified"));
        assert!(out.contains("# combat"));
        assert!(out.contains("hello world"));
    }

    #[test]
    fn skips_cheatsheet() {
        assert!(reformat_doctrine_markdown("x", "ops/rag-ingestion-cheatsheet.md").is_none());
    }
}
