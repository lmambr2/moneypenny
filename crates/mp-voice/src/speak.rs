// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Strip markdown/citation chrome so Piper does not read `**bold**` or Sources.

pub fn strip_markdown_for_speech(raw: &str) -> String {
    let mut t = raw.replace("\r\n", "\n");
    if let Some(i) = t.to_ascii_lowercase().find("sources:") {
        t.truncate(i);
        t = t.trim_end_matches(['\n', ' ', '📎']).to_string();
    }
    t = strip_fences(&t);
    t = t.replace('`', " ");
    t = strip_md_links(&t);
    let mut out = String::new();
    for line in t.lines() {
        let mut l = line.trim_start();
        while l.starts_with('#') {
            l = l.trim_start_matches('#').trim_start();
        }
        let l = l
            .trim_start_matches(|c: char| matches!(c, '-' | '*' | '+' | '•') || c.is_ascii_digit() || c == '.' || c == ')' || c == ' ')
            .replace(['|', '#', '>', '~'], " ");
        out.push_str(&l);
        out.push(' ');
    }
    let no_url = strip_urls(&out);
    no_url.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_fences(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find("```") {
        out.push_str(&rest[..start]);
        out.push(' ');
        rest = &rest[start + 3..];
        if let Some(end) = rest.find("```") {
            rest = &rest[end + 3..];
        } else {
            break;
        }
    }
    out.push_str(rest);
    out
}

fn strip_md_links(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '[' {
            let mut label = String::new();
            let mut found = false;
            while let Some(&n) = chars.peek() {
                chars.next();
                if n == ']' {
                    found = true;
                    break;
                }
                label.push(n);
            }
            if found && chars.peek() == Some(&'(') {
                chars.next();
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if n == ')' {
                        break;
                    }
                }
                out.push_str(&label);
            } else {
                out.push('[');
                out.push_str(&label);
                if found {
                    out.push(']');
                }
            }
        } else {
            out.push(c);
        }
    }
    out.replace("**", "").replace("__", "").replace('*', "").replace('_', " ")
}

fn strip_urls(s: &str) -> String {
    s.split_whitespace()
        .filter(|w| !w.starts_with("http://") && !w.starts_with("https://"))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn text_to_spoken(raw: &str) -> String {
    strip_markdown_for_speech(raw)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn split_spoken_sentences(text: &str) -> Vec<String> {
    let spoken = text_to_spoken(text);
    if spoken.is_empty() {
        return Vec::new();
    }
    let mut sentences = Vec::new();
    let mut cur = String::new();
    for c in spoken.chars() {
        cur.push(c);
        if matches!(c, '.' | '!' | '?' | '…') {
            let t = cur.trim().to_string();
            if !t.is_empty() {
                sentences.push(t);
            }
            cur.clear();
        }
    }
    let rest = cur.trim();
    if !rest.is_empty() {
        sentences.push(rest.to_string());
    }
    sentences
}

pub fn tts_timeout_for_text(text: &str, base_ms: u64, max_ms: u64) -> u64 {
    (base_ms.max(text.len() as u64 * 40)).min(max_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_sources_and_bold() {
        let s = text_to_spoken("**Hello** team.\n\n📎 Sources: combat.md");
        assert!(s.to_lowercase().starts_with("hello"));
        assert!(!s.to_lowercase().contains("sources"));
    }
}
