// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Port of `bot/src/llm/client.ts` `extractAssistantText`.

/// Prefer `content`; if empty (Gemma-4 reasoning models), salvage a spoken line
/// from `reasoning`. Strips markdown fences / bullet thinking noise.
pub fn extract_assistant_text(content: Option<&str>, reasoning: Option<&str>) -> String {
    let from_content = content.unwrap_or("").trim();
    if !from_content.is_empty() {
        return strip_assistant_noise(from_content);
    }
    let reasoning = reasoning.unwrap_or("").trim();
    if reasoning.is_empty() {
        return String::new();
    }
    let lines: Vec<&str> = reasoning
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    for l in lines.iter().rev() {
        let mut l = l.trim().to_string();
        l = l
            .trim_matches(|c| c == '"' || c == '\'' || c == '`')
            .trim()
            .to_string();
        if l.len() < 8 || l.len() > 600 {
            continue;
        }
        if l.starts_with(['*', '-', '#', '•']) {
            continue;
        }
        let lower = l.to_ascii_lowercase();
        if lower.starts_with("constraint")
            || lower.starts_with("role")
            || lower.starts_with("tone")
            || lower.starts_with("thinking")
            || lower.starts_with("note")
            || lower.starts_with("step")
            || lower.starts_with("rule")
        {
            continue;
        }
        if is_numbered_bullet(&l) {
            continue;
        }
        return strip_assistant_noise(&l);
    }
    String::new()
}

fn is_numbered_bullet(l: &str) -> bool {
    let t = l.trim_start_matches(['*', ' ']);
    let mut chars = t.chars();
    let mut saw_digit = false;
    for c in chars.by_ref() {
        if c.is_ascii_digit() {
            saw_digit = true;
            continue;
        }
        if saw_digit && (c == '.' || c == ')') {
            return chars.next().is_some_and(|n| n.is_whitespace());
        }
        break;
    }
    false
}

fn strip_assistant_noise(text: &str) -> String {
    let mut t = text.trim().to_string();
    if let Some(rest) = t.strip_prefix("```") {
        t = rest
            .trim_start_matches(|c: char| c.is_ascii_alphanumeric())
            .trim_start()
            .to_string();
    }
    if let Some(rest) = t.strip_suffix("```") {
        t = rest.trim_end().to_string();
    }
    for label in ["spoken line", "bumper", "announcement"] {
        let prefix = format!("{label}:");
        if let Some(rest) = t.get(..prefix.len()) {
            if rest.eq_ignore_ascii_case(&prefix) {
                t = t[prefix.len()..].trim().to_string();
                break;
            }
        }
    }
    t.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_content() {
        assert_eq!(
            extract_assistant_text(
                Some("Stay sharp on formation arrivals."),
                Some("* thinking about doctrine...")
            ),
            "Stay sharp on formation arrivals."
        );
    }

    #[test]
    fn salvages_reasoning() {
        let reasoning = "*   Role: Radio announcer.\n*   Constraint: under 75 words.\n*   Drafting...\nHeavies establish the perimeter before the larger ships jump.";
        assert_eq!(
            extract_assistant_text(Some(""), Some(reasoning)),
            "Heavies establish the perimeter before the larger ships jump."
        );
    }

    #[test]
    fn empty_when_nothing_usable() {
        assert_eq!(
            extract_assistant_text(None, Some("* only bullets\n* more")),
            ""
        );
    }
}
