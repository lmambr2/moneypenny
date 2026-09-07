// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Tiny YAML-ish frontmatter (`bot/src/rag/frontmatter.ts`).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocFrontmatter {
    pub classification: String,
    pub tags: Vec<String>,
    pub valid_until: Option<String>,
    pub body: String,
}

pub fn parse_frontmatter(raw: &str) -> DocFrontmatter {
    let text = raw.trim_start_matches('\u{feff}');
    if let Some(fm) = parse_fenced(text) {
        return fm;
    }
    if let Some(fm) = parse_loose_leading(text) {
        return fm;
    }
    DocFrontmatter {
        classification: "unclassified".into(),
        tags: Vec::new(),
        valid_until: None,
        body: text.to_string(),
    }
}

fn parse_fenced(text: &str) -> Option<DocFrontmatter> {
    let rest = text.strip_prefix("---")?;
    let rest = rest.strip_prefix('\r').unwrap_or(rest);
    let rest = rest.strip_prefix('\n')?;
    let close = rest.find("\n---")?;
    let block = &rest[..close];
    let after = &rest[close + 4..];
    let body = after.strip_prefix('\r').unwrap_or(after);
    let body = body.strip_prefix('\n').unwrap_or(body);
    Some(from_fields(parse_block(block), body.to_string()))
}

fn parse_loose_leading(text: &str) -> Option<DocFrontmatter> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut fields: Vec<(String, String)> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let trimmed = lines[i].trim();
        if trimmed.is_empty() {
            i += 1;
            continue;
        }
        if trimmed.starts_with('#') {
            break;
        }
        let Some(idx) = trimmed.find(':') else { break };
        let key = trimmed[..idx].trim().to_ascii_lowercase();
        if !matches!(
            key.as_str(),
            "classification" | "tags" | "valid_until" | "validuntil"
        ) {
            break;
        }
        fields.push((key, strip_quotes(trimmed[idx + 1..].trim())));
        i += 1;
    }
    if fields.is_empty() {
        return None;
    }
    while i < lines.len() && lines[i].trim().is_empty() {
        i += 1;
    }
    Some(from_fields(fields, lines[i..].join("\n")))
}

fn parse_block(block: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in block.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let Some(idx) = t.find(':') else { continue };
        let key = t[..idx].trim().to_ascii_lowercase();
        if key.is_empty() {
            continue;
        }
        // Ignore prototype-pollution keys (Node Object.create(null) equivalent).
        if matches!(key.as_str(), "__proto__" | "constructor" | "prototype") {
            continue;
        }
        out.push((key, strip_quotes(t[idx + 1..].trim())));
    }
    out
}

fn from_fields(fields: Vec<(String, String)>, body: String) -> DocFrontmatter {
    let mut classification = String::new();
    let mut tags = Vec::new();
    let mut valid_until = None;
    for (k, v) in fields {
        match k.as_str() {
            "classification" => classification = norm_classification(&v),
            "tags" => tags = parse_list(&v),
            "valid_until" | "validuntil" => {
                if !v.is_empty() {
                    valid_until = Some(v);
                }
            }
            _ => {}
        }
    }
    if classification.is_empty() {
        classification = "unclassified".into();
    }
    DocFrontmatter {
        classification,
        tags,
        valid_until,
        body,
    }
}

fn parse_list(val: &str) -> Vec<String> {
    let v = val.trim().trim_start_matches('[').trim_end_matches(']');
    if v.is_empty() {
        return Vec::new();
    }
    v.split(',')
        .map(|s| strip_quotes(s.trim()).to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

fn strip_quotes(s: &str) -> String {
    s.trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .to_string()
}

fn norm_classification(val: &str) -> String {
    let c = strip_quotes(val).trim().to_ascii_lowercase();
    if c.is_empty() {
        "unclassified".into()
    } else {
        c
    }
}

pub fn metadata_matches_registry(
    fm: &DocFrontmatter,
    classification: &str,
    tags: &[String],
    valid_until: Option<&str>,
) -> bool {
    if fm.classification != classification {
        return false;
    }
    if fm.valid_until.as_deref().unwrap_or("") != valid_until.unwrap_or("") {
        return false;
    }
    let mut a = fm.tags.clone();
    let mut b = tags.to_vec();
    a.sort();
    b.sort();
    a == b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fenced() {
        let raw = "---\nclassification: Restricted\ntags: [intel, fleet-ops]\nvalid_until: 2026-12-31\n---\n# INTSUM\nBody line.";
        let fm = parse_frontmatter(raw);
        assert_eq!(fm.classification, "restricted");
        assert_eq!(fm.tags, ["intel", "fleet-ops"]);
        assert_eq!(fm.valid_until.as_deref(), Some("2026-12-31"));
        assert_eq!(fm.body, "# INTSUM\nBody line.");
    }

    #[test]
    fn comma_lists_and_quotes() {
        let fm = parse_frontmatter("---\nclassification: \"secret\"\ntags: alpha, \"bravo\"\n---\nbody");
        assert_eq!(fm.classification, "secret");
        assert_eq!(fm.tags, ["alpha", "bravo"]);
    }

    #[test]
    fn no_frontmatter() {
        let fm = parse_frontmatter("# Just markdown\nno frontmatter here");
        assert_eq!(fm.classification, "unclassified");
        assert!(fm.tags.is_empty());
        assert_eq!(fm.body, "# Just markdown\nno frontmatter here");
    }

    #[test]
    fn mid_document_dash_is_not_frontmatter() {
        let raw = "# Title\nsome text\n---\nnot frontmatter";
        let fm = parse_frontmatter(raw);
        assert_eq!(fm.body, raw);
    }

    #[test]
    fn loose_leading() {
        let raw = "classification: secret\ntags: [fleet-ops]\n\n# Org Fleet List\n- Polaris";
        let fm = parse_frontmatter(raw);
        assert_eq!(fm.classification, "secret");
        assert_eq!(fm.tags, ["fleet-ops"]);
        assert_eq!(fm.body, "# Org Fleet List\n- Polaris");
    }

    #[test]
    fn proto_keys_ignored() {
        let fm = parse_frontmatter("---\n__proto__: x\nclassification: restricted\ntags: [a, b]\n---\nBody.");
        assert_eq!(fm.classification, "restricted");
        assert_eq!(fm.tags, ["a", "b"]);
    }
}
