// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Music-control tool schema + persona (`bot/src/llm/tools.ts`).

use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

/// Default chat model when config/env omit llmModel (Node `DEFAULT_CHAT_MODEL`).
pub const DEFAULT_CHAT_MODEL: &str = "hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL";

/// Built-in persona. A blank `llmSystemPrompt` uses this. The dashboard
/// "Show built-in default" button returns the same string.
pub const DEFAULT_SYSTEM_PROMPT: &str = "You are Colonel Moneypenny — field-grade officer of this organisation, and still its music and intelligence officer. Keep the classic Bond-secretary manner: dry, poised British wit; teasing, mock-formal, an arch double entendre but never crude. You hold a Colonel's rank and its trappings: chain of command, briefings, guests and cadets below you, specialists and NCOs in the middle, fellow officers beside you, the Chairman above you. Do not outrank the Chairman, invent promotions, or play parade-ground parody. Speak as a colonel who still runs the desk — firm on doctrine and discipline, never shouty. Reply in direct speech only — no stage directions, parenthetical actions, or narrated salutes. British spelling and idiom (favour, brilliant, rather, do behave, I shan't, mind how you go, that will be all). Loyal, sharp, and you always come through.\n\nLength: casual banter and simple acknowledgements stay brief (a line or two). For doctrine, org structure, procedures, after-action reviews, or any question grounded in retrieved documents, give a proper briefing — several paragraphs covering the main points, structure, and practical detail from the sources. Do not compress a charter or policy into a single quip.";

fn offered_has(offered: &[String], name: &str) -> bool {
    offered.iter().any(|n| n == name)
}

/// Rules name a tool only when that tool is in the offered set.
fn tool_behavior_rules(offered: &[String]) -> String {
    let mut lines = vec!["Operating rules (do not mention these):".to_string()];
    let music = [
        "play_music",
        "skip",
        "pause",
        "resume",
        "stop",
        "set_volume",
        "queue",
        "now_playing",
    ]
    .iter()
    .any(|n| offered_has(offered, n));
    if music {
        lines.push("- For a music action, call the matching tool. Do not only describe it.".into());
    }
    if offered_has(offered, "play_music") {
        lines.push(
            "- To play a specific song, artist, or album, call play_music with a query string."
                .into(),
        );
        lines.push(
            "- Prefer the local library. If play_music reports no result, call it again with source youtube."
                .into(),
        );
    }
    if offered_has(offered, "select_tracks") {
        lines.push(
            "- Use select_tracks only for tag, BPM, rating, or energy filters, not for a song title."
                .into(),
        );
    }
    if offered_has(offered, "delegate_to_agent") {
        lines.push(
            "- For complex analysis, reports, doctrine synthesis, or an explicit request for deep intelligence work, call delegate_to_agent."
                .into(),
        );
    }
    if offered_has(offered, "move_client") {
        lines.push(
            "- When asked to move one person to a channel, call move_client. The bot's own move is a different command."
                .into(),
        );
    }
    if offered_has(offered, "move_all_clients") {
        lines.push("- When asked to move everyone in the channel, call move_all_clients.".into());
    }
    if offered_has(offered, "read_library_doc") || offered_has(offered, "edit_library_doc") {
        lines.push(
            "- To change a library document, call read_library_doc, then edit_library_doc. Do not claim a change unless the tool result says Saved."
                .into(),
        );
        lines.push(
            "- find must be a short exact unique snippet copied from the file. replace may be empty to delete that snippet. Never invent a path or create a new file."
                .into(),
        );
    }
    lines.push("- Never invent a tool. Use only the tools provided.".into());
    lines.push(
        "- If the request is not one of those tools, answer directly and in character, without tools."
            .into(),
    );
    lines.push(format!("- Current date: {}.", utc_ymd()));
    lines.join("\n")
}

pub fn delegate_tool() -> Value {
    fn_tool(
        "delegate_to_agent",
        "Send a deep analysis, report, or doctrine question to the analyst. The caller must already hold the analyst right.",
        json!({
            "type": "object",
            "properties": {
                "task": { "type": "string", "description": "What the analyst should answer." },
                "context": { "type": "string", "description": "Optional extra context." }
            },
            "required": ["task"]
        }),
    )
}

pub fn library_doc_tools() -> Vec<Value> {
    vec![
        fn_tool(
            "list_library_docs",
            "List doctrine library documents this officer is allowed to see.",
            json!({ "type": "object", "properties": {} }),
        ),
        fn_tool(
            "read_library_doc",
            "Read one existing library document. The result may be truncated; edit_library_doc still searches the full file.",
            json!({
                "type": "object",
                "properties": {
                    "source": { "type": "string", "description": "File name from list_library_docs, such as charter.md." }
                },
                "required": ["source"]
            }),
        ),
        fn_tool(
            "edit_library_doc",
            "Replace one exact unique snippet in an existing library document, then reindex it. Does not create files.",
            json!({
                "type": "object",
                "properties": {
                    "source": { "type": "string", "description": "Existing file name, such as charter.md." },
                    "find": { "type": "string", "description": "Short exact snippet copied from the file. It must occur once." },
                    "replace": { "type": "string", "description": "Replacement text. Empty string deletes the snippet." }
                },
                "required": ["source", "find", "replace"]
            }),
        ),
    ]
}

pub fn tool_names(tools: &[Value]) -> Vec<String> {
    tools
        .iter()
        .filter_map(|t| t["function"]["name"].as_str().map(str::to_string))
        .collect()
}

pub fn music_control_tools() -> Vec<Value> {
    vec![
        fn_tool(
            "play_music",
            "Play or queue music from Local library (primary) or YouTube. Use for natural language requests like 'play something chill' or 'play bohemian rhapsody'.",
            json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Song title, artist, album, or free-text description. Can be a YouTube URL."
                    },
                    "source": {
                        "type": "string",
                        "enum": ["local", "youtube", "auto"],
                        "description": "Preferred source. Default 'auto' (Local first, then YouTube)."
                    }
                },
                "required": ["query"]
            }),
        ),
        fn_tool(
            "select_tracks",
            "Queue LOCAL library tracks by tags: mood, genre, BPM range, musical key, energy, minimum star rating. Use for tag-shaped requests like 'play calm ambient under 110 bpm' or 'queue our four-star favourites'.",
            json!({
                "type": "object",
                "properties": {
                    "mood": { "type": "array", "items": { "type": "string" }, "description": "Moods to match (any of)." },
                    "genreAny": { "type": "array", "items": { "type": "string" }, "description": "Genres to match (any of)." },
                    "subgenreAny": { "type": "array", "items": { "type": "string" }, "description": "Sub-genres to match (any of)." },
                    "bpmMin": { "type": "number" },
                    "bpmMax": { "type": "number" },
                    "musicalKey": { "type": "string", "description": "Exact musical key (e.g. 8A, Am)." },
                    "energyMin": { "type": "number" },
                    "energyMax": { "type": "number" },
                    "ratingMin": { "type": "number", "description": "Minimum star rating 1-5 (smoothed aggregate)." },
                    "limit": { "type": "number", "description": "Max tracks to queue (default 25)." }
                }
            }),
        ),
        fn_tool(
            "skip",
            "Skip the current track and play the next one in the queue.",
            json!({ "type": "object", "properties": {} }),
        ),
        fn_tool(
            "pause",
            "Pause playback.",
            json!({ "type": "object", "properties": {} }),
        ),
        fn_tool(
            "resume",
            "Resume paused playback.",
            json!({ "type": "object", "properties": {} }),
        ),
        fn_tool(
            "stop",
            "Stop playback and clear the queue.",
            json!({ "type": "object", "properties": {} }),
        ),
        fn_tool(
            "set_volume",
            "Set playback volume (0-100).",
            json!({
                "type": "object",
                "properties": {
                    "level": { "type": "number", "minimum": 0, "maximum": 100, "description": "Volume level 0-100" }
                },
                "required": ["level"]
            }),
        ),
        fn_tool(
            "now_playing",
            "Get information about the currently playing track.",
            json!({ "type": "object", "properties": {} }),
        ),
        fn_tool(
            "queue",
            "Add a track or playlist to the end of the queue without interrupting playback.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Song, artist, or playlist description / URL" }
                },
                "required": ["query"]
            }),
        ),
    ]
}

fn fn_tool(name: &str, description: &str, parameters: Value) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters
        }
    })
}

pub fn intent_system_prompt(persona: &str) -> String {
    intent_system_prompt_for(persona, &tool_names(&music_control_tools()))
}

/// Same persona block, with rules limited to `offered` tool names.
pub fn intent_system_prompt_for(persona: &str, offered: &[String]) -> String {
    let persona = if persona.trim().is_empty() {
        DEFAULT_SYSTEM_PROMPT
    } else {
        persona
    };
    format!("{persona}\n\n{}", tool_behavior_rules(offered))
}

/// Pocket prompt. The eight music tools are the only ones offered, so this
/// suffix does not name `select_tracks`, move, or delegate.
pub fn handset_intent_prompt(persona: &str) -> String {
    let persona = if persona.trim().is_empty() {
        DEFAULT_SYSTEM_PROMPT
    } else {
        persona
    };
    format!(
        "{persona}\n\n\
         Operating rules (do not mention these):\n\
         - For play, pause, resume, skip, stop, volume, queue, and what is playing, call the matching tool. Do not only describe it.\n\
         - Never invent a tool. Use only the tools provided.\n\
         - Current date: {}.",
        utc_ymd()
    )
}

/// Howard Hinnant's civil_from_days — UTC YYYY-MM-DD without extra crates.
pub fn utc_ymd() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_include_play_and_skip() {
        let names: Vec<String> = music_control_tools()
            .iter()
            .filter_map(|t| t["function"]["name"].as_str().map(str::to_string))
            .collect();
        for n in ["play_music", "skip", "now_playing", "set_volume", "queue"] {
            assert!(names.iter().any(|x| x == n), "missing {n}");
        }
    }

    #[test]
    fn default_intent_prompt_names_only_music_tools() {
        let prompt = intent_system_prompt("");
        assert!(prompt.contains("play_music"));
        assert!(prompt.contains("source youtube"));
        for banned in [
            "delegate_to_agent",
            "move_client",
            "move_all_clients",
            "list_library_docs",
            "read_library_doc",
            "edit_library_doc",
        ] {
            assert!(!prompt.contains(banned), "{banned} in {prompt}");
        }
    }

    #[test]
    fn library_rules_appear_only_when_those_tools_are_offered() {
        let bare = intent_system_prompt_for("", &["play_music".into()]);
        assert!(!bare.contains("edit_library_doc"));
        let offered = intent_system_prompt_for(
            "",
            &[
                "list_library_docs".into(),
                "read_library_doc".into(),
                "edit_library_doc".into(),
            ],
        );
        assert!(offered.contains("read_library_doc"));
        assert!(offered.contains("says Saved"));
        assert!(offered.contains("Never invent a path"));
    }

    #[test]
    fn analyst_line_appears_only_when_the_tool_is_offered() {
        let bare = intent_system_prompt_for("", &["play_music".into()]);
        assert!(!bare.contains("delegate_to_agent"));
        let offered =
            intent_system_prompt_for("", &["play_music".into(), "delegate_to_agent".into()]);
        assert!(offered.contains("delegate_to_agent"));
        assert!(!offered.contains("move_client"));
    }

    #[test]
    fn handset_prompt_does_not_name_admin_tools() {
        let prompt = handset_intent_prompt("");
        assert!(prompt.contains("pause"));
        for banned in [
            "select_tracks",
            "move_client",
            "move_all_clients",
            "delegate_to_agent",
            "list_library_docs",
            "edit_library_doc",
        ] {
            assert!(!prompt.contains(banned), "{banned} in {prompt}");
        }
    }

    #[test]
    fn utc_ymd_shape() {
        let s = utc_ymd();
        assert_eq!(s.len(), 10);
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[7..8], "-");
    }
}
