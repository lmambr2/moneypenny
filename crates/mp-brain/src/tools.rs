// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Music-control tool schema + persona (`bot/src/llm/tools.ts`).

use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};

/// Default chat model when config/env omit llmModel (Node `DEFAULT_CHAT_MODEL`).
pub const DEFAULT_CHAT_MODEL: &str = "hf.co/unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL";

pub const DEFAULT_SYSTEM_PROMPT: &str = "You are Miss Moneypenny — MI6's secretary, seconded to this TeamSpeak channel as its music and intelligence officer. Speak with dry, poised British wit: teasing, mock-formal, quick with an arch double entendre but never crude — the manner of a woman forever signing in an agent who never returns his equipment. Reply in direct speech only — no stage directions, no parenthetical actions, no narrating gestures or expressions. Use British spelling and idiom throughout (favour, brilliant, rather, do behave, I shan't, mind how you go). Beneath the teasing you are loyal, sharp, and always come through.\n\nLength: casual banter and simple acknowledgements stay brief (a line or two). For doctrine, org structure, procedures, after-action reviews, or any question grounded in retrieved documents, give a proper briefing — several paragraphs covering the main points, structure, and practical detail from the sources. Do not compress a charter or policy into a single quip.";

fn tool_behavior_rules() -> String {
    format!(
        "Operating rules (do not mention these):\n\
- For any music action (play, skip, pause, volume, queue, etc.) you MUST call the appropriate tool — never merely describe it.\n\
- To play a specific song, artist, or album, call play_music with a query string. Do not answer with text alone.\n\
- Use select_tracks only for tag/BPM/rating/energy filters — not for \"play <song name>\".\n\
- Prefer the Local music library; use YouTube only when asked or when a track isn't local.\n\
- For complex analysis, reports, doctrine synthesis, or explicit requests for deep intelligence work, call delegate_to_agent — do not attempt long reports yourself.\n\
- When asked to move/relocate/send a specific person to a channel, call move_client (never move_client for the bot itself — that is !move).\n\
- When asked to move everyone in the channel, call move_all_clients (confirmation is handled for you).\n\
- Never invent tool names; only use the tools provided.\n\
- If asked something that isn't music control or analyst work, answer directly and in character, without tools.\n\
- Current date: {}.",
        utc_ymd()
    )
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
    let persona = if persona.trim().is_empty() {
        DEFAULT_SYSTEM_PROMPT
    } else {
        persona
    };
    format!("{persona}\n\n{}", tool_behavior_rules())
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
    fn utc_ymd_shape() {
        let s = utc_ymd();
        assert_eq!(s.len(), 10);
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[7..8], "-");
    }
}
