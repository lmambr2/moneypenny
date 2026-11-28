// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Static operator skills (PR-H2). Markdown in `{data_dir}/skills/`.
//! Caps: 4 files, 2 KiB each, 6 KiB total. Overflow drops whole files.
//! No `when:` router and no playbook capture.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

pub const SKILL_MAX_FILES: usize = 4;
pub const SKILL_MAX_FILE_BYTES: usize = 2 * 1024;
pub const SKILL_MAX_TOTAL_BYTES: usize = 6 * 1024;

#[derive(Debug, Clone, Default)]
pub struct LoadedSkills {
    pub text: String,
    pub tools: HashSet<String>,
    pub declares_tools: bool,
    pub max_steps: Option<u32>,
    pub dropped: Vec<String>,
}

/// Missing directory is empty, not an error. `*.example.md` is skipped.
pub fn load_skills(dir: &Path) -> LoadedSkills {
    let entries = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return LoadedSkills::default(),
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".md") && !n.ends_with(".example.md"))
        .collect();
    names.sort();

    let mut loaded = LoadedSkills::default();
    let mut total = 0usize;
    for file in names {
        if packed_count(&loaded.text) >= SKILL_MAX_FILES {
            loaded.dropped.push(file);
            continue;
        }
        let raw = match fs::read(dir.join(&file)) {
            Ok(b) => b,
            Err(_) => {
                loaded.dropped.push(file);
                continue;
            }
        };
        if raw.len() > SKILL_MAX_FILE_BYTES || total + raw.len() > SKILL_MAX_TOTAL_BYTES {
            loaded.dropped.push(file);
            continue;
        }
        let text = String::from_utf8_lossy(&raw).into_owned();
        let (meta, body) = parse_frontmatter(&text);
        let body = body.trim();
        if body.is_empty() {
            loaded.dropped.push(file);
            continue;
        }
        let listed = parse_tools(meta.get("tools").map(String::as_str).unwrap_or(""));
        if !listed.is_empty() {
            loaded.declares_tools = true;
        }
        for t in &listed {
            loaded.tools.insert(t.clone());
        }
        if let Some(steps) = meta.get("maxSteps").and_then(|s| s.parse::<u32>().ok()) {
            if steps > 0 {
                loaded.max_steps = Some(match loaded.max_steps {
                    Some(prev) => prev.min(steps),
                    None => steps,
                });
            }
        }
        let name = meta
            .get("name")
            .cloned()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| file.trim_end_matches(".md").to_string());
        if !loaded.text.is_empty() {
            loaded.text.push_str("\n\n");
        }
        loaded.text.push_str(&format!("## {name}\n{body}"));
        total += raw.len();
    }
    loaded
}

fn packed_count(text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        text.lines().filter(|l| l.starts_with("## ")).count()
    }
}

fn parse_frontmatter(raw: &str) -> (std::collections::HashMap<String, String>, &str) {
    let text = raw.trim_start_matches('\u{feff}');
    if !text.starts_with("---") {
        return (std::collections::HashMap::new(), text.trim());
    }
    let Some(end) = text[3..].find("\n---") else {
        return (std::collections::HashMap::new(), text.trim());
    };
    let block = text[3..3 + end].trim();
    let body = text[3 + end + 4..].trim();
    let mut meta = std::collections::HashMap::new();
    for line in block.lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        if k.trim().is_empty() {
            continue;
        }
        meta.insert(k.trim().to_string(), v.trim().to_string());
    }
    (meta, body)
}

fn parse_tools(raw: &str) -> Vec<String> {
    raw.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .map(|s| s.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Skill list intersects the channel allowlist. `None` means the skill did not declare tools.
pub fn skill_blocks(
    name: &str,
    tools: Option<&HashSet<String>>,
    allow_dangerous: bool,
) -> Option<String> {
    let set = tools?;
    let in_policy = if allow_dangerous {
        mp_control::HARNESS_SAFE_TOOLS.contains(&name)
            || mp_control::HARNESS_DANGEROUS_TOOLS.contains(&name)
    } else {
        mp_control::HARNESS_SAFE_TOOLS.contains(&name)
    };
    if set.contains(name) && in_policy {
        None
    } else {
        Some(format!("tool not in skill ∩ channel policy: {name}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, body: &str) {
        fs::write(dir.join(name), body).unwrap();
    }

    #[test]
    fn packs_two_and_drops_oversize_and_example() {
        let dir = std::env::temp_dir().join(format!("mp-skills-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        write(
            &dir,
            "a.md",
            "---\nname: hangar\ntools: [play_music, move_all_clients]\nmaxSteps: 2\n---\nPrefer local.\n",
        );
        write(&dir, "b.md", "Second skill.\n");
        write(&dir, "skip.example.md", "nope\n");
        write(&dir, "big.md", &"x".repeat(SKILL_MAX_FILE_BYTES + 1));
        let loaded = load_skills(&dir);
        assert!(loaded.text.contains("## hangar"));
        assert!(loaded.text.contains("Prefer local."));
        assert!(loaded.text.contains("## b"));
        assert!(loaded.declares_tools);
        assert!(loaded.tools.contains("play_music"));
        assert_eq!(loaded.max_steps, Some(2));
        assert!(loaded.dropped.iter().any(|d| d == "big.md"));
        assert!(!loaded.text.contains("nope"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_dir_is_empty() {
        let loaded = load_skills(Path::new("/tmp/mp-skills-missing-nope-rust"));
        assert!(loaded.text.is_empty());
        assert!(!loaded.declares_tools);
    }

    #[test]
    fn intersection_blocks_a_tool_outside_the_skill() {
        let mut tools = HashSet::new();
        tools.insert("play_music".into());
        assert!(skill_blocks("play_music", Some(&tools), false).is_none());
        assert!(skill_blocks("move_all_clients", Some(&tools), true).is_some());
        assert!(skill_blocks("move_all_clients", None, true).is_none());
    }
}
