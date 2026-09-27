// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! `!intsum` / `!aar` bullet parse and follow-up text. Port of `docs/workflow.ts`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkflowKind {
    Intsum,
    Aar,
}

impl WorkflowKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Intsum => "intsum",
            Self::Aar => "aar",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowRequest {
    pub kind: WorkflowKind,
    pub bullets: Vec<String>,
    pub classification: String,
    pub save: bool,
}

pub fn workflow_usage(kind: WorkflowKind) -> &'static str {
    match kind {
        WorkflowKind::Intsum => "Usage: !intsum [-s] [class:<level>] <key points — separate with ; or |>",
        WorkflowKind::Aar => "Usage: !aar [-s] [class:<level>] <key points — separate with ; or |>",
    }
}

pub fn parse_workflow(kind: WorkflowKind, args: &str, save: bool) -> Result<WorkflowRequest, String> {
    let mut raw = args.trim().to_string();
    if raw.is_empty() {
        return Err(workflow_usage(kind).into());
    }
    let mut classification = match kind {
        WorkflowKind::Intsum => "restricted",
        WorkflowKind::Aar => "unclassified",
    }
    .to_string();
    if let Some(start) = raw.to_ascii_lowercase().find("class:") {
        let after = &raw[start + 6..];
        let token: String = after
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
            .collect();
        if !token.is_empty() && token.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
            classification = token.to_ascii_lowercase();
            let end = start + 6 + token.len();
            raw = format!("{} {}", raw[..start].trim(), raw[end..].trim());
            raw = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        }
    }
    if raw.trim().is_empty() {
        return Err(workflow_usage(kind).into());
    }
    let sep = if raw.contains('|') {
        Some('|')
    } else if raw.contains(';') {
        Some(';')
    } else {
        None
    };
    let bullets: Vec<String> = match sep {
        Some(sep) => raw.split(sep).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        None => vec![raw.trim().to_string()],
    };
    if bullets.is_empty() {
        return Err(workflow_usage(kind).into());
    }
    Ok(WorkflowRequest {
        kind,
        bullets,
        classification,
        save,
    })
}

pub fn format_workflow_follow_up(kind: WorkflowKind, result: &str, invoker_name: Option<&str>) -> String {
    let label = match invoker_name {
        Some(name) if !name.is_empty() => format!("{} ({name})", kind.as_str().to_uppercase()),
        _ => kind.as_str().to_uppercase(),
    };
    format!("📋 {label}:\n{result}")
}

pub const DELEGATE_UNCONFIGURED: &str =
    "Analyst delegation is not configured. Set a delegate URL in Settings.";

pub fn workflow_system(kind: WorkflowKind) -> &'static str {
    match kind {
        WorkflowKind::Intsum => {
            "You draft short intelligence summaries (INTSUMs) for an operations community. \
The operator supplies bullet key points; expand them into a concise, professional INTSUM. \
Output ONLY valid Markdown: YAML frontmatter (classification, tags, valid_until) then body sections. \
Use ## headings. Stay factual — do not invent events beyond what the bullets imply; mark gaps as unknown. \
Keep it under ~600 words. valid_until should be ~30 days from today unless bullets specify otherwise."
        }
        WorkflowKind::Aar => {
            "You draft short After-Action Reports (AARs) for an operations community. \
The operator supplies bullet key points; expand them into a structured AAR. \
Output ONLY valid Markdown: YAML frontmatter (classification, tags) then body sections. \
Cover mission/objectives, execution, what went well, what didn't, and concrete lessons/recommendations. \
Stay factual — do not invent events beyond what the bullets imply. Keep it under ~700 words."
        }
    }
}

fn skeleton(kind: WorkflowKind) -> &'static str {
    match kind {
        WorkflowKind::Intsum => {
            "---\nclassification: <level>\ntags: [intel, intsum]\nvalid_until: <YYYY-MM-DD>\n---\n\n# INTSUM <date>\n\n## Executive Summary\n\n## Key Judgments\n\n## Situation\n\n## Assessment\n\n## Outlook"
        }
        WorkflowKind::Aar => {
            "---\nclassification: <level>\ntags: [aar, after-action]\n---\n\n# After-Action Report — <title>\n\n## Mission / Objectives\n\n## Execution\n\n## What Went Well\n\n## What Didn't / Friction\n\n## Lessons & Recommendations"
        }
    }
}

pub fn build_workflow_task(req: &WorkflowRequest, today: &str) -> String {
    let bullets = req
        .bullets
        .iter()
        .enumerate()
        .map(|(i, b)| format!("{}. {b}", i + 1))
        .collect::<Vec<_>>()
        .join("\n");
    let body = skeleton(req.kind)
        .replace("<level>", &req.classification)
        .replace("<date>", today);
    format!(
        "Draft a {} using this skeleton (fill every section; adjust title/date):\n\n{body}\n\nOperator key points:\n{bullets}\n\nSet classification in frontmatter to: {}\nReply with the finished Markdown document only — no preamble or commentary.",
        req.kind.as_str().to_uppercase(),
        req.classification
    )
}

pub fn workflow_save_path(kind: WorkflowKind, today: &str) -> String {
    let folder = match kind {
        WorkflowKind::Intsum => "intel",
        WorkflowKind::Aar => "reports",
    };
    format!("{folder}/{}-{today}.md", kind.as_str())
}

pub fn append_save_notice(doc: &str, saved: Result<&str, &str>) -> String {
    match saved {
        Ok(source) => format!("{doc}\n\n💾 Saved to knowledge base: {source}"),
        Err(err) => format!("{doc}\n\n⚠️ Could not save: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_intsum_bullets_and_formats_follow_up() {
        let req = parse_workflow(WorkflowKind::Intsum, "alpha secure; comms ok", false).unwrap();
        assert_eq!(req.bullets, vec!["alpha secure", "comms ok"]);
        assert_eq!(req.classification, "restricted");
        let out = format_workflow_follow_up(WorkflowKind::Intsum, "---\n# INTSUM\nbody", None);
        assert!(out.contains("INTSUM"), "{out}");
        assert!(out.contains("# INTSUM"), "{out}");
    }

    #[test]
    fn empty_args_are_usage() {
        let err = parse_workflow(WorkflowKind::Aar, "  ", false).unwrap_err();
        assert!(err.contains("Usage"), "{err}");
    }
}
