// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Pandoc export for doctrine (docx/pdf). Fail-soft if pandoc is missing.

use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportError {
    InvalidFormat,
    PandocUnavailable,
    Empty,
    PandocFailed,
}

impl ExportError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidFormat => "INVALID_FORMAT",
            Self::PandocUnavailable => "PANDOC_UNAVAILABLE",
            Self::Empty => "EMPTY",
            Self::PandocFailed => "PANDOC_FAILED",
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            Self::InvalidFormat | Self::Empty => 400,
            Self::PandocUnavailable => 503,
            Self::PandocFailed => 502,
        }
    }
}

impl std::fmt::Display for ExportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidFormat => "format must be docx or pdf",
            Self::PandocUnavailable => "pandoc is not installed or not on PATH",
            Self::Empty => "document is empty",
            Self::PandocFailed => "pandoc export failed",
        })
    }
}

pub fn is_pandoc_available() -> bool {
    Command::new("pandoc")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn prepare_markdown_for_export(markdown: &str) -> String {
    let marker = "\n\n📎 Sources:";
    let cut = markdown.find(marker).unwrap_or(markdown.len());
    markdown[..cut].trim().to_string()
}

pub fn export_filename(source: &str, format: &str) -> String {
    let posix = source.replace('\\', "/");
    let file = posix.rsplit('/').next().unwrap_or("document");
    let base = file
        .trim_end_matches(".markdown")
        .trim_end_matches(".md");
    let ext = if format == "pdf" { "pdf" } else { "docx" };
    format!("{base}.{ext}")
}

pub fn export_content_type(format: &str) -> &'static str {
    if format == "pdf" {
        "application/pdf"
    } else {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }
}

pub fn export_markdown(markdown: &str, format: &str) -> Result<Vec<u8>, ExportError> {
    if format != "docx" && format != "pdf" {
        return Err(ExportError::InvalidFormat);
    }
    if !is_pandoc_available() {
        return Err(ExportError::PandocUnavailable);
    }
    let body = prepare_markdown_for_export(markdown);
    if body.is_empty() {
        return Err(ExportError::Empty);
    }
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("moneypenny-export-{n}"));
    let _ = std::fs::create_dir_all(&dir);
    let input = dir.join("input.md");
    let ext = if format == "pdf" { "pdf" } else { "docx" };
    let output = dir.join(format!("output.{ext}"));
    let write = (|| {
        std::fs::write(&input, body.as_bytes()).map_err(|_| ExportError::PandocFailed)?;
        let st = Command::new("pandoc")
            .arg(&input)
            .arg("-o")
            .arg(&output)
            .status()
            .map_err(|_| ExportError::PandocFailed)?;
        if !st.success() {
            return Err(ExportError::PandocFailed);
        }
        std::fs::read(&output).map_err(|_| ExportError::PandocFailed)
    })();
    let _ = std::fs::remove_dir_all(&dir);
    write
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_sources_footer() {
        let s = prepare_markdown_for_export("Hello\n\n📎 Sources:\n- a");
        assert_eq!(s, "Hello");
    }

    #[test]
    fn filename_from_source() {
        assert_eq!(export_filename("ops/combat.md", "docx"), "combat.docx");
    }
}
