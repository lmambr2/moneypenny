// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! LLM tool call → ParsedCommand (`bot/src/control/tool-map.ts`).

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::manifest::{ParsedCommand, COMMAND_MANIFEST};

#[derive(Debug, Clone)]
pub struct ToolCallInput {
    pub name: String,
    pub arguments: Value,
}

/// Map source preference from play_music/queue tools to a provider flag.
pub fn source_flags(source: Option<&str>) -> HashSet<char> {
    let mut flags = HashSet::new();
    match source {
        Some("youtube") => {
            flags.insert('y');
        }
        Some("local") => {
            flags.insert('l');
        }
        _ => {}
    }
    flags
}

fn make(name: &str, args: &str, flags: HashSet<char>) -> ParsedCommand {
    ParsedCommand {
        name: name.to_string(),
        args: args.to_string(),
        raw_args: if args.is_empty() {
            Vec::new()
        } else {
            args.split_whitespace().map(str::to_string).collect()
        },
        flags,
    }
}

fn js_falsy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => true,
        Some(Value::Bool(false)) => true,
        Some(Value::Number(n)) => n.as_f64() == Some(0.0),
        Some(Value::String(s)) if s.is_empty() => true,
        _ => false,
    }
}

fn as_finite_number(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64().filter(|x| x.is_finite()),
        Some(Value::String(s)) => s.parse::<f64>().ok().filter(|x| x.is_finite()),
        _ => None,
    }
}

fn map_play_music(a: &Value) -> Option<ParsedCommand> {
    let query = a
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if query.is_empty() {
        return None;
    }
    let flags = source_flags(a.get("source").and_then(|v| v.as_str()));
    Some(ParsedCommand {
        name: "play".into(),
        args: query.clone(),
        raw_args: query.split_whitespace().map(str::to_string).collect(),
        flags,
    })
}

fn map_queue(a: &Value) -> Option<ParsedCommand> {
    let query = a
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if query.is_empty() {
        return None;
    }
    Some(make("add", &query, HashSet::new()))
}

fn map_select_tracks(a: &Value) -> Option<ParsedCommand> {
    let genres = a.get("genreAny").and_then(|v| v.as_array());
    if let Some(genres) = genres {
        if genres.len() == 1
            && genres[0].as_str().is_some()
            && js_falsy(a.get("mood"))
            && js_falsy(a.get("bpmMin"))
            && js_falsy(a.get("bpmMax"))
            && js_falsy(a.get("ratingMin"))
        {
            let q = genres[0]
                .as_str()
                .unwrap()
                .trim_matches(|c| c == '[' || c == ']')
                .trim();
            if !q.is_empty() {
                return Some(make("play", q, HashSet::new()));
            }
        }
    }
    let json = serde_json::to_string(a).unwrap_or_else(|_| "{}".into());
    Some(make("selecttracks", &json, HashSet::new()))
}

fn map_set_volume(a: &Value) -> Option<ParsedCommand> {
    let level = as_finite_number(a.get("level"))?;
    Some(make("vol", &format!("{}", level.round() as i64), HashSet::new()))
}

fn map_move_client(a: &Value) -> Option<ParsedCommand> {
    let client = a
        .get("client")
        .or_else(|| a.get("target"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let channel = a
        .get("channel")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if client.is_empty() || channel.is_empty() {
        return None;
    }
    Some(ParsedCommand {
        name: "moveclient".into(),
        args: format!("{client} {channel}"),
        raw_args: vec![client.to_string(), channel.to_string()],
        flags: HashSet::new(),
    })
}

fn map_move_all(a: &Value) -> Option<ParsedCommand> {
    let channel = a
        .get("channel")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if channel.is_empty() {
        return None;
    }
    Some(make("moveall", channel, HashSet::new()))
}

/// Simple tool name → command name from manifest `llmTool` fields.
pub fn simple_tool_alias_map() -> HashMap<String, String> {
    let mut m = HashMap::new();
    for s in COMMAND_MANIFEST {
        m.insert(s.name.to_string(), s.name.to_string());
        if let Some(tool) = s.llm_tool {
            m.insert(tool.to_string(), s.name.to_string());
        }
    }
    m
}

/// Translate an LLM music-control tool call into a synthetic ParsedCommand.
/// Returns None for tools we don't recognize.
pub fn tool_call_to_command(name: &str, arguments: &Value) -> Option<ParsedCommand> {
    let a = if arguments.is_object() {
        arguments
    } else {
        &Value::Object(Default::default())
    };

    match name {
        "play_music" => return map_play_music(a),
        "queue" => return map_queue(a),
        "select_tracks" => return map_select_tracks(a),
        "set_volume" => return map_set_volume(a),
        "move_client" => return map_move_client(a),
        "move_all_clients" => return map_move_all(a),
        _ => {}
    }

    let aliases = simple_tool_alias_map();
    let cmd_name = aliases.get(name)?;

    if name == "skip"
        || name == "pause"
        || name == "resume"
        || name == "stop"
        || name == "now_playing"
        || cmd_name == name
    {
        if matches!(
            name,
            "now_playing" | "skip" | "pause" | "resume" | "stop"
        ) {
            return Some(make(cmd_name, "", HashSet::new()));
        }
    }

    let q = a
        .get("query")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            a.get("target")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .or_else(|| {
            a.get("prompt")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or("");
    let flags = source_flags(
        a.get("source")
            .and_then(|v| v.as_str())
            .or_else(|| a.get("platform").and_then(|v| v.as_str())),
    );
    Some(make(cmd_name, q, flags))
}

pub fn known_llm_tool_names() -> Vec<String> {
    let mut names: HashSet<String> = [
        "play_music",
        "queue",
        "select_tracks",
        "set_volume",
        "move_client",
        "move_all_clients",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    for s in COMMAND_MANIFEST {
        names.insert(s.name.to_string());
        if let Some(t) = s.llm_tool {
            names.insert(t.to_string());
        }
    }
    let mut v: Vec<String> = names.into_iter().collect();
    v.sort();
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn play_music_with_youtube_source() {
        let cmd = tool_call_to_command(
            "play_music",
            &json!({ "query": "Never Gonna Give You Up", "source": "youtube" }),
        )
        .unwrap();
        assert_eq!(cmd.name, "play");
        assert!(cmd.args.contains("Never Gonna"));
        assert!(cmd.flags.contains(&'y'));
    }

    #[test]
    fn select_tracks_lone_genre_is_play() {
        let cmd = tool_call_to_command("select_tracks", &json!({ "genreAny": ["Jazz"] })).unwrap();
        assert_eq!(cmd.name, "play");
        assert_eq!(cmd.args, "Jazz");
    }

    #[test]
    fn select_tracks_with_mood_stays_json() {
        let cmd = tool_call_to_command(
            "select_tracks",
            &json!({ "genreAny": ["Jazz"], "mood": ["calm"] }),
        )
        .unwrap();
        assert_eq!(cmd.name, "selecttracks");
        assert!(cmd.args.contains("calm"));
    }

    #[test]
    fn set_volume_rounds_level() {
        let cmd = tool_call_to_command("set_volume", &json!({ "level": 42.6 })).unwrap();
        assert_eq!(cmd.args, "43");
    }

    #[test]
    fn move_client_and_move_all() {
        let m = tool_call_to_command(
            "move_client",
            &json!({ "client": "Bob", "channel": "Hangar" }),
        )
        .unwrap();
        assert_eq!(m.name, "moveclient");
        assert_eq!(m.raw_args, ["Bob", "Hangar"]);
        assert_eq!(
            tool_call_to_command("move_all_clients", &json!({ "channel": "Lobby" }))
                .unwrap()
                .name,
            "moveall"
        );
    }

    #[test]
    fn simple_aliases() {
        assert_eq!(tool_call_to_command("skip", &json!({})).unwrap().name, "skip");
        assert_eq!(
            tool_call_to_command("now_playing", &json!({})).unwrap().name,
            "now"
        );
        assert!(tool_call_to_command("unknown_tool_xyz", &json!({})).is_none());
    }

    #[test]
    fn source_flags_values() {
        assert!(source_flags(Some("youtube")).contains(&'y'));
        assert!(source_flags(Some("local")).contains(&'l'));
        assert!(source_flags(Some("auto")).is_empty());
    }

    #[test]
    fn known_names_include_specials() {
        let names = known_llm_tool_names();
        assert!(names.iter().any(|n| n == "play_music"));
        assert!(names.iter().any(|n| n == "select_tracks"));
        assert!(names.iter().any(|n| n == "now_playing"));
    }

    #[test]
    fn queue_tool_maps_to_add() {
        let cmd = tool_call_to_command("queue", &json!({ "query": "jazz" })).unwrap();
        assert_eq!(cmd.name, "add");
        assert_eq!(cmd.args, "jazz");
    }

    #[test]
    fn invalid_play_and_volume() {
        assert!(tool_call_to_command("play_music", &json!({ "query": "  " })).is_none());
        assert!(tool_call_to_command("set_volume", &json!({ "level": "loud" })).is_none());
        assert!(tool_call_to_command("frobnicate", &json!({})).is_none());
    }
}
