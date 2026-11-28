// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Library tools for an officer who already holds `reindex`.
//! Edit is an exact unique find/replace on a file that already exists.
//! A full rewrite does not fit in one tool-call generation.

use serde_json::Value;

use crate::doctrine::{DoctrineStore, MAX_DOCTRINE_FILE_BYTES};
use crate::frontmatter::parse_frontmatter;
use crate::ingest::ingest_doctrine_doc;
use crate::store::{RetrievalStore, RetrievedChunk};

const LIST_CAP: usize = 60;
const READ_CHARS: usize = 24_000;
const GROUNDING_CHARS: usize = 12_000;

const NO_RETRIEVAL: &str = "No knowledge-base documents were retrieved for this question. Do not invent document titles, file names, charters, or policies. Ordinary conversation needs no citation. If the question asks for a document you were not given, say you have no document on it.";

pub fn is_library_tool(name: &str) -> bool {
    matches!(
        name,
        "list_library_docs" | "read_library_doc" | "edit_library_doc"
    )
}

pub async fn run_library_tool(
    retrieval: &RetrievalStore,
    doctrine: &DoctrineStore,
    name: &str,
    args: &Value,
    allowed: &[String],
) -> String {
    match name {
        "list_library_docs" => list_docs(doctrine, allowed),
        "read_library_doc" => read_doc(doctrine, args, allowed),
        "edit_library_doc" => edit_doc(retrieval, doctrine, args, allowed).await,
        _ => format!("unknown or invalid tool: {name}"),
    }
}

/// Same grounding block `!ask` already uses, so an officer question still
/// answers from the library when no edit is required.
pub fn library_grounding(chunks: &[RetrievedChunk]) -> (String, Vec<String>) {
    let (body, names) = excerpts_within(chunks, GROUNDING_CHARS);
    if body.is_empty() {
        return (NO_RETRIEVAL.into(), Vec::new());
    }
    (
        format!(
            "Doctrine / knowledge base — ground answers in this when applicable; do not invent facts. \
             Name a document, file, charter, or policy only when that title appears in this block. \
             If this block does not cover the question, say you have no document on it. \
             Do not write a Sources list; one is added for you. \
             To change a file, use the library tools. These excerpts are not the whole file.\n\n{body}"
        ),
        names,
    )
}

fn list_docs(doctrine: &DoctrineStore, allowed: &[String]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut rows = Vec::new();
    for doc in doctrine.list() {
        let Some(class) = file_class(doctrine, &doc.source) else {
            continue;
        };
        if !class_allowed(&class, allowed) {
            continue;
        }
        seen.insert(doc.source.clone());
        rows.push((doc.source, class, doc.chunks));
    }
    for source in doctrine.files() {
        if seen.contains(&source) {
            continue;
        }
        let Some(class) = file_class(doctrine, &source) else {
            continue;
        };
        if !class_allowed(&class, allowed) {
            continue;
        }
        rows.push((source, class, 0));
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    format_doc_list(&rows)
}

fn read_doc(doctrine: &DoctrineStore, args: &Value, allowed: &[String]) -> String {
    let Some(raw) = arg_str(args, "source") else {
        return "source is required.".into();
    };
    let Some(source) = resolve_source(doctrine, &raw) else {
        return format!("No document named {}.", shown_name(&raw));
    };
    let Some(content) = doctrine.read_file(&source) else {
        return format!("No document named {source}.");
    };
    let class = parse_frontmatter(&content).classification;
    if !class_allowed(&class, allowed) {
        return format!("You can't read {source}.");
    }
    let mut body: String = content.chars().take(READ_CHARS).collect();
    let truncated = content.chars().count() > READ_CHARS;
    if truncated {
        body.push_str("\n\n[truncated; the edit tool still searches the full file]");
    }
    format!("{source} ({class}, {} bytes)\n\n{body}", content.len())
}

async fn edit_doc(
    retrieval: &RetrievalStore,
    doctrine: &DoctrineStore,
    args: &Value,
    allowed: &[String],
) -> String {
    let Some(raw) = arg_str(args, "source") else {
        return "source is required.".into();
    };
    let Some(source) = resolve_source(doctrine, &raw) else {
        return format!("No document named {}.", shown_name(&raw));
    };
    let Some(current) = doctrine.read_file(&source) else {
        return format!("No document named {source}.");
    };
    let old = parse_frontmatter(&current);
    if !class_allowed(&old.classification, allowed) {
        return format!("You can't read {source}.");
    }
    let Some(find) = arg_str(args, "find") else {
        return "find is required.".into();
    };
    if find.trim().is_empty() {
        return "find must be a short exact snippet, not blank.".into();
    }
    let Some(replace) = arg_str(args, "replace") else {
        return "replace is required (use an empty string to delete the snippet).".into();
    };
    let count = current.matches(find.as_str()).count();
    if count == 0 {
        return format!("That snippet is not in {source}.");
    }
    if count != 1 {
        return format!("That snippet appears {count} times. Send a longer exact snippet.");
    }
    if find == replace {
        let chunks = doctrine.get(&source).map(|d| d.chunks).unwrap_or(0);
        return saved(&source, chunks, &old.classification);
    }
    let updated = current.replacen(&find, &replace, 1);
    if updated.trim().is_empty() {
        return "That edit would leave the document empty.".into();
    }
    if updated.len() > MAX_DOCTRINE_FILE_BYTES {
        return "That edit would exceed the 15 MiB limit.".into();
    }
    let new_fm = parse_frontmatter(&updated);
    if !class_allowed(&new_fm.classification, allowed) {
        return format!("You can't set classification to {}.", new_fm.classification);
    }
    match ingest_doctrine_doc(retrieval, doctrine, &source, &updated).await {
        Ok(doc) => saved(&doc.source, doc.chunks as i64, &doc.classification),
        Err(e) => format!("Could not save {source}: {e}"),
    }
}

fn saved(source: &str, chunks: i64, classification: &str) -> String {
    format!("Saved {source} ({chunks} chunks, {classification}).")
}

fn resolve_source(doctrine: &DoctrineStore, raw: &str) -> Option<String> {
    let normalized = DoctrineStore::normalize_source(raw.trim());
    doctrine.safe_name(&normalized)
}

fn file_class(doctrine: &DoctrineStore, source: &str) -> Option<String> {
    let text = doctrine.read_file(source)?;
    Some(parse_frontmatter(&text).classification)
}

fn class_allowed(class: &str, allowed: &[String]) -> bool {
    allowed.iter().any(|c| c == class)
}

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

fn shown_name(raw: &str) -> String {
    let t = raw.trim();
    if t.is_empty() {
        return "(empty)".into();
    }
    let mut out: String = t.chars().take(180).collect();
    if t.chars().count() > 180 {
        out.push('…');
    }
    out
}

fn format_doc_list(rows: &[(String, String, i64)]) -> String {
    if rows.is_empty() {
        return "The library has no documents you can see.".into();
    }
    let mut lines = Vec::new();
    for (source, class, chunks) in rows.iter().take(LIST_CAP) {
        lines.push(format!("{source} — {class}, {chunks} chunks"));
    }
    if rows.len() > LIST_CAP {
        lines.push(format!("… and {} more.", rows.len() - LIST_CAP));
    }
    lines.join("\n")
}

fn excerpts_within(chunks: &[RetrievedChunk], limit: usize) -> (String, Vec<String>) {
    let mut body = String::new();
    let mut names = Vec::new();
    for chunk in chunks {
        let text = chunk.text.trim();
        if text.is_empty() {
            continue;
        }
        if body.len() >= limit {
            break;
        }
        let name = chunk.source.trim();
        let header = format!("[{name}]\n");
        let room = limit.saturating_sub(body.len());
        if header.len() >= room {
            break;
        }
        let room = room - header.len();
        let clipped = clip_chars(text, room);
        if clipped.is_empty() {
            break;
        }
        body.push_str(&header);
        body.push_str(clipped);
        body.push_str("\n\n");
        if !name.is_empty() && !names.iter().any(|n: &String| n == name) {
            names.push(name.to_string());
        }
    }
    (body, names)
}

fn clip_chars(text: &str, room: usize) -> &str {
    if text.len() <= room {
        return text;
    }
    let mut end = room;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embeddings::Embedder;
    use crate::vector::{MemoryVectorStore, VectorStore};
    use mp_db::Database;
    use std::sync::Arc;

    struct Fixture {
        retrieval: RetrievalStore,
        doctrine: DoctrineStore,
        dir: std::path::PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "mp-libtool-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let db = Arc::new(Database::open_in_memory().unwrap());
            let doctrine = DoctrineStore::new(Arc::clone(&db), &dir).unwrap();
            let retrieval = RetrievalStore::new(
                Embedder::Hash { dim: 32 },
                VectorStore::Memory(MemoryVectorStore::new()),
                "doctrine".into(),
                4,
            );
            Self {
                retrieval,
                doctrine,
                dir,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    async fn seed(fx: &Fixture, source: &str, body: &str) {
        ingest_doctrine_doc(&fx.retrieval, &fx.doctrine, source, body)
            .await
            .unwrap();
    }

    fn open() -> &'static [&'static str] {
        &["unclassified"]
    }

    fn allowed(levels: &[&str]) -> Vec<String> {
        levels.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn list_formatter_caps_at_sixty() {
        let rows: Vec<(String, String, i64)> = (0..61)
            .map(|i| (format!("d{i:02}.md"), "unclassified".into(), 1))
            .collect();
        let text = format_doc_list(&rows);
        assert!(text.contains("d00.md"));
        assert!(!text.contains("d60.md —"));
        assert!(text.contains("… and 1 more."));
    }

    #[tokio::test]
    async fn unique_replace_reingests() {
        let fx = Fixture::new();
        seed(
            &fx,
            "charter.md",
            "---\nclassification: unclassified\n---\n\n# Charter\n\nThe fleet stands.\n",
        )
        .await;
        let msg = run_library_tool(
            &fx.retrieval,
            &fx.doctrine,
            "edit_library_doc",
            &serde_json::json!({
                "source": "charter",
                "find": "The fleet stands.",
                "replace": "The fleet holds."
            }),
            &allowed(open()),
        )
        .await;
        assert!(msg.starts_with("Saved charter.md"), "{msg}");
        assert!(msg.contains("unclassified"), "{msg}");
        let disk = fx.doctrine.read_file("charter.md").unwrap();
        assert!(disk.contains("The fleet holds."));
        assert!(!disk.contains("The fleet stands."));
        let hits = fx
            .retrieval
            .query("fleet holds", Some(3), Some(&allowed(open())))
            .await;
        assert!(hits.iter().any(|h| h.source == "charter.md"), "{hits:?}");
    }

    #[tokio::test]
    async fn double_match_and_missing_find_leave_the_file() {
        let fx = Fixture::new();
        let original = "---\nclassification: unclassified\n---\n\nalpha and alpha\n";
        seed(&fx, "twice.md", original).await;
        let twice = run_library_tool(
            &fx.retrieval,
            &fx.doctrine,
            "edit_library_doc",
            &serde_json::json!({"source": "twice.md", "find": "alpha", "replace": "beta"}),
            &allowed(open()),
        )
        .await;
        assert!(twice.contains("appears 2 times"), "{twice}");
        let missing = run_library_tool(
            &fx.retrieval,
            &fx.doctrine,
            "edit_library_doc",
            &serde_json::json!({"source": "twice.md", "find": "nope", "replace": "beta"}),
            &allowed(open()),
        )
        .await;
        assert!(missing.contains("not in twice.md"), "{missing}");
        assert_eq!(fx.doctrine.read_file("twice.md").unwrap(), original);
    }

    #[tokio::test]
    async fn list_hides_secret_and_secret_write_is_refused() {
        let fx = Fixture::new();
        seed(
            &fx,
            "open.md",
            "---\nclassification: unclassified\n---\n\nPublic line.\n",
        )
        .await;
        seed(
            &fx,
            "sealed.md",
            "---\nclassification: secret\n---\n\nSealed line.\n",
        )
        .await;
        let listed = run_library_tool(
            &fx.retrieval,
            &fx.doctrine,
            "list_library_docs",
            &serde_json::json!({}),
            &allowed(open()),
        )
        .await;
        assert!(listed.contains("open.md"), "{listed}");
        assert!(!listed.contains("sealed.md"), "{listed}");
        let denied = run_library_tool(
            &fx.retrieval,
            &fx.doctrine,
            "read_library_doc",
            &serde_json::json!({"source": "sealed.md"}),
            &allowed(open()),
        )
        .await;
        assert_eq!(denied, "You can't read sealed.md.");
        let bumped = run_library_tool(
            &fx.retrieval,
            &fx.doctrine,
            "edit_library_doc",
            &serde_json::json!({
                "source": "open.md",
                "find": "classification: unclassified",
                "replace": "classification: secret"
            }),
            &allowed(open()),
        )
        .await;
        assert!(
            bumped.contains("can't set classification to secret"),
            "{bumped}"
        );
        assert!(
            fx.doctrine
                .read_file("open.md")
                .unwrap()
                .contains("classification: unclassified")
        );
    }

    #[tokio::test]
    async fn traversal_and_create_are_refused() {
        let fx = Fixture::new();
        seed(
            &fx,
            "open.md",
            "---\nclassification: unclassified\n---\n\nStay.\n",
        )
        .await;
        let escaped = run_library_tool(
            &fx.retrieval,
            &fx.doctrine,
            "edit_library_doc",
            &serde_json::json!({"source": "../outside.md", "find": "Stay.", "replace": "Gone."}),
            &allowed(open()),
        )
        .await;
        assert!(escaped.starts_with("No document named"), "{escaped}");
        assert!(!fx.dir.join("outside.md").exists());
        assert!(!fx.dir.join("doctrine").join("../outside.md").exists());
        let created = run_library_tool(
            &fx.retrieval,
            &fx.doctrine,
            "edit_library_doc",
            &serde_json::json!({"source": "brand-new.md", "find": "x", "replace": "y"}),
            &allowed(open()),
        )
        .await;
        assert_eq!(created, "No document named brand-new.md.");
        assert!(fx.doctrine.read_file("brand-new.md").is_none());
        assert!(fx.doctrine.read_file("open.md").unwrap().contains("Stay."));
    }

    #[tokio::test]
    async fn blank_find_and_same_text_do_not_rewrite() {
        let fx = Fixture::new();
        let original = "---\nclassification: unclassified\n---\n\nSame.\n";
        seed(&fx, "same.md", original).await;
        let blank = run_library_tool(
            &fx.retrieval,
            &fx.doctrine,
            "edit_library_doc",
            &serde_json::json!({"source": "same.md", "find": "  \n", "replace": "x"}),
            &allowed(open()),
        )
        .await;
        assert!(blank.contains("not blank"), "{blank}");
        let noop = run_library_tool(
            &fx.retrieval,
            &fx.doctrine,
            "edit_library_doc",
            &serde_json::json!({"source": "same.md", "find": "Same.", "replace": "Same."}),
            &allowed(open()),
        )
        .await;
        assert!(noop.starts_with("Saved same.md"), "{noop}");
        assert_eq!(fx.doctrine.read_file("same.md").unwrap(), original);
    }

    #[tokio::test]
    async fn empty_replace_deletes_the_snippet() {
        let fx = Fixture::new();
        seed(
            &fx,
            "trim.md",
            "---\nclassification: unclassified\n---\n\nKeep. Drop this.\n",
        )
        .await;
        let msg = run_library_tool(
            &fx.retrieval,
            &fx.doctrine,
            "edit_library_doc",
            &serde_json::json!({"source": "trim.md", "find": " Drop this.", "replace": ""}),
            &allowed(open()),
        )
        .await;
        assert!(msg.starts_with("Saved trim.md"), "{msg}");
        let disk = fx.doctrine.read_file("trim.md").unwrap();
        assert!(disk.contains("Keep."));
        assert!(!disk.contains("Drop this."));
    }

    #[tokio::test]
    async fn read_truncates_but_edit_still_sees_the_tail() {
        let fx = Fixture::new();
        let mut body = "---\nclassification: unclassified\n---\n\n".to_string();
        body.push_str(&"a".repeat(READ_CHARS + 500));
        body.push_str("TAILMARKER");
        seed(&fx, "long.md", &body).await;
        let shown = run_library_tool(
            &fx.retrieval,
            &fx.doctrine,
            "read_library_doc",
            &serde_json::json!({"source": "long.md"}),
            &allowed(open()),
        )
        .await;
        assert!(shown.contains("[truncated"), "{shown}");
        assert!(!shown.contains("TAILMARKER"));
        let edited = run_library_tool(
            &fx.retrieval,
            &fx.doctrine,
            "edit_library_doc",
            &serde_json::json!({
                "source": "long.md",
                "find": "TAILMARKER",
                "replace": "DONE"
            }),
            &allowed(open()),
        )
        .await;
        assert!(edited.starts_with("Saved long.md"), "{edited}");
        assert!(fx.doctrine.read_file("long.md").unwrap().contains("DONE"));
    }

    #[test]
    fn empty_library_message() {
        assert_eq!(
            format_doc_list(&[]),
            "The library has no documents you can see."
        );
    }
}
