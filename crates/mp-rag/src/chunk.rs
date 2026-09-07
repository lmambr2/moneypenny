// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Heading-aware markdown chunking (`bot/src/rag/chunk.ts`).

use sha1::{Digest, Sha1};

pub const DEFAULT_CHUNK_MAX_CHARS: usize = 2048;
pub const DEFAULT_CHUNK_OVERLAP: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub id: String,
    pub text: String,
    pub source: String,
    pub index: usize,
}

pub fn chunk_id(source: &str, index: usize) -> String {
    let h = hex::encode(Sha1::digest(format!("{source}#{index}").as_bytes()));
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

pub fn chunk_markdown(
    source: &str,
    md: &str,
    max_chars: usize,
    overlap: usize,
) -> Vec<Chunk> {
    let text = md.replace("\r\n", "\n").trim().to_string();
    if text.is_empty() {
        return Vec::new();
    }
    let mut pieces = Vec::new();
    for section in split_by_heading(&text) {
        if section.len() <= max_chars {
            pieces.push(section);
        } else {
            pieces.extend(size_chunks(&section, max_chars, overlap));
        }
    }
    pieces
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .enumerate()
        .map(|(i, t)| Chunk {
            id: chunk_id(source, i),
            text: t,
            source: source.to_string(),
            index: i,
        })
        .collect()
}

pub fn chunk_markdown_default(source: &str, md: &str) -> Vec<Chunk> {
    chunk_markdown(source, md, DEFAULT_CHUNK_MAX_CHARS, DEFAULT_CHUNK_OVERLAP)
}

fn split_by_heading(text: &str) -> Vec<String> {
    let mut sections = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in text.split('\n') {
        if heading_line(line) && !current.is_empty() {
            sections.push(current.join("\n"));
            current = vec![line];
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        sections.push(current.join("\n"));
    }
    if sections.is_empty() {
        vec![text.to_string()]
    } else {
        sections
    }
}

fn heading_line(line: &str) -> bool {
    let b = line.as_bytes();
    let mut n = 0;
    while n < b.len() && n < 6 && b[n] == b'#' {
        n += 1;
    }
    n >= 1 && n < b.len() && b[n] == b' '
}

fn size_chunks(text: &str, max_chars: usize, overlap: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0;
    let chars: Vec<char> = text.chars().collect();
    while start < chars.len() {
        let mut end = (start + max_chars).min(chars.len());
        if end < chars.len() {
            let slice: String = chars[start..end].iter().collect();
            let break_at = [
                slice.rfind("\n\n"),
                slice.rfind('\n'),
                slice.rfind(". "),
            ]
            .into_iter()
            .flatten()
            .max()
            .unwrap_or(0);
            if break_at > max_chars / 2 {
                end = start + break_at + 1;
            }
        }
        out.push(chars[start..end].iter().collect());
        if end >= chars.len() {
            break;
        }
        start = end.saturating_sub(overlap).max(start + 1);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_is_deterministic_uuid() {
        let a = chunk_id("doc.md", 0);
        assert_eq!(chunk_id("doc.md", 0), a);
        assert!(
            regex_uuid(&a),
            "{a}"
        );
        assert_ne!(chunk_id("doc.md", 0), chunk_id("doc.md", 1));
        assert_ne!(chunk_id("a.md", 0), chunk_id("b.md", 0));
    }

    fn regex_uuid(s: &str) -> bool {
        s.len() == 36
            && s.as_bytes()[8] == b'-'
            && s.as_bytes()[13] == b'-'
            && s.as_bytes()[18] == b'-'
            && s.as_bytes()[23] == b'-'
            && s.chars().filter(|c| *c != '-').all(|c| c.is_ascii_hexdigit())
    }

    #[test]
    fn empty_is_nothing() {
        assert!(chunk_markdown_default("s", "").is_empty());
        assert!(chunk_markdown_default("s", "   \n  ").is_empty());
    }

    #[test]
    fn splits_on_headings() {
        let md = "# Doctrine\nIntro line.\n## Alpha\nAlpha body.\n## Bravo\nBravo body.";
        let chunks = chunk_markdown_default("doctrine.md", md);
        assert_eq!(chunks.len(), 3);
        assert!(chunks[0].text.contains("# Doctrine"));
        assert!(chunks[1].text.contains("## Alpha"));
        assert!(chunks[2].text.contains("## Bravo"));
        assert_eq!(chunks.iter().map(|c| c.index).collect::<Vec<_>>(), vec![0, 1, 2]);
    }

    #[test]
    fn size_splits() {
        let big = format!("## Big\n{}", "word ".repeat(200));
        let chunks = chunk_markdown("big.md", &big, 300, 30);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.text.chars().count() <= 301));
    }

    #[test]
    fn plain_text_one_section() {
        let chunks = chunk_markdown_default("note.txt", "just a short note");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].text, "just a short note");
    }

    #[test]
    fn ids_stable() {
        let md = "# A\nbody a\n# B\nbody b";
        let a = chunk_markdown_default("x.md", md);
        let b = chunk_markdown_default("x.md", md);
        assert_eq!(
            a.iter().map(|c| &c.id).collect::<Vec<_>>(),
            b.iter().map(|c| &c.id).collect::<Vec<_>>()
        );
    }
}
