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

/// Complete sentences from a growing LLM buffer. The first item is what TTS starts on.
pub fn push_stream_delta(buf: &mut String, delta: &str) -> Vec<String> {
    buf.push_str(delta);
    let mut sentences = Vec::new();
    let mut last = 0usize;
    let chars: Vec<(usize, char)> = buf.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        let (idx, ch) = chars[i];
        if matches!(ch, '.' | '!' | '?' | '…') {
            let end = idx + ch.len_utf8();
            let next_is_break = chars.get(i + 1).is_none_or(|(_, n)| n.is_whitespace());
            if next_is_break {
                let piece = buf[last..end].trim();
                if !piece.is_empty() {
                    sentences.push(piece.to_string());
                }
                last = chars.get(i + 1).map(|(n, _)| *n).unwrap_or(buf.len());
                while chars.get(i + 1).is_some_and(|(_, n)| n.is_whitespace()) {
                    i += 1;
                    last = chars.get(i + 1).map(|(n, _)| *n).unwrap_or(buf.len());
                }
            }
        }
        i += 1;
    }
    if last > 0 {
        *buf = buf[last..].to_string();
    }
    sentences
}

/// Spoken chunks for TTS. The first chunk is the first sentence, with the Sources footer removed.
pub fn tts_speak_chunks(reply: &str) -> Vec<String> {
    let spoken = text_to_spoken(reply);
    if spoken.is_empty() {
        return Vec::new();
    }
    let mut buf = String::new();
    let mut sentences = push_stream_delta(&mut buf, &spoken);
    if !buf.trim().is_empty() {
        sentences.push(buf.trim().to_string());
    }
    sentences
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

    #[test]
    fn first_tts_chunk_is_the_first_sentence_without_sources() {
        let chunks = tts_speak_chunks("Hello team. More later.\n\n📎 Sources: combat.md");
        assert_eq!(chunks.first().map(String::as_str), Some("Hello team."));
        assert!(chunks.iter().all(|c| !c.to_lowercase().contains("sources")));
        assert!(chunks.len() >= 2);
    }

    #[test]
    fn stream_emits_a_sentence_as_soon_as_it_closes() {
        let mut buf = String::new();
        assert!(push_stream_delta(&mut buf, "Hello").is_empty());
        let ready = push_stream_delta(&mut buf, " team. Still");
        assert_eq!(ready, vec!["Hello team.".to_string()]);
        assert!(buf.contains("Still"));
    }
}
