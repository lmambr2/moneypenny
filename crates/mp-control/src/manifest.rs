// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! COMMAND_MANIFEST + parseCommand. Port of `bot/src/bot/commands.ts`.

use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandKind {
    Resolved,
    Delegated,
    Special,
    Router,
}

#[derive(Debug, Clone)]
pub struct CommandSpec {
    pub name: &'static str,
    pub kind: CommandKind,
    pub admin: bool,
    pub audio: bool,
    pub llm_tool: Option<&'static str>,
}

pub const COMMAND_MANIFEST: &[CommandSpec] = &[
    spec_llm("play", CommandKind::Resolved, false, true, "play_music"),
    spec_llm("add", CommandKind::Resolved, false, true, "queue"),
    spec("playnext", CommandKind::Resolved, false, true),
    spec("pn", CommandKind::Resolved, false, true),
    spec("playlist", CommandKind::Resolved, false, true),
    spec("album", CommandKind::Resolved, false, true),
    spec_llm("skip", CommandKind::Delegated, false, true, "skip"),
    spec("next", CommandKind::Delegated, false, true),
    spec("jump", CommandKind::Delegated, false, true),
    spec("go", CommandKind::Delegated, false, true),
    spec("prev", CommandKind::Delegated, false, true),
    spec_llm("pause", CommandKind::Delegated, false, false, "pause"),
    spec_llm("resume", CommandKind::Delegated, false, false, "resume"),
    spec_llm("stop", CommandKind::Delegated, true, false, "stop"),
    spec("clear", CommandKind::Delegated, true, false),
    spec_llm("vol", CommandKind::Delegated, true, false, "set_volume"),
    spec("remove", CommandKind::Delegated, true, false),
    spec("mode", CommandKind::Delegated, true, false),
    spec("ban", CommandKind::Delegated, true, false),
    spec("unban", CommandKind::Delegated, true, false),
    spec_llm("now", CommandKind::Delegated, false, false, "now_playing"),
    spec("queue", CommandKind::Delegated, false, false),
    spec("list", CommandKind::Delegated, false, false),
    spec("artist", CommandKind::Delegated, false, true),
    spec("test", CommandKind::Delegated, false, true),
    spec("karaoke", CommandKind::Delegated, false, false),
    spec("lyrics", CommandKind::Delegated, false, false),
    spec("vote", CommandKind::Delegated, false, false),
    spec("help", CommandKind::Delegated, false, false),
    spec("chevron7", CommandKind::Delegated, false, true),
    spec("radio", CommandKind::Delegated, false, false),
    spec("rate", CommandKind::Delegated, false, false),
    spec("unrate", CommandKind::Delegated, false, false),
    spec_llm("selecttracks", CommandKind::Delegated, false, false, "select_tracks"),
    spec("move", CommandKind::Delegated, true, false),
    spec_llm("moveclient", CommandKind::Delegated, true, false, "move_client"),
    spec_llm("moveall", CommandKind::Delegated, true, false, "move_all_clients"),
    spec("follow", CommandKind::Delegated, true, false),
    spec("roast", CommandKind::Special, false, false),
    spec("roastout", CommandKind::Special, false, false),
    spec("roastin", CommandKind::Special, false, false),
    spec("remember", CommandKind::Special, false, false),
    spec("recall", CommandKind::Special, false, false),
    spec("forget", CommandKind::Special, false, false),
    spec("kg", CommandKind::Special, false, false),
    spec("diary", CommandKind::Special, false, false),
    spec("ships", CommandKind::Special, false, false),
    spec("hangar", CommandKind::Special, false, false),
    spec("ops", CommandKind::Special, false, false),
    spec("session", CommandKind::Special, true, false),
    spec("mute", CommandKind::Special, true, false),
    spec("kick", CommandKind::Special, true, false),
    spec("mine", CommandKind::Special, false, false),
    spec("refine", CommandKind::Special, false, false),
    spec("craft", CommandKind::Special, false, false),
    spec("econ", CommandKind::Special, false, false),
    spec("trade", CommandKind::Special, false, false),
    spec("workorder", CommandKind::Special, false, false),
    spec("work-items", CommandKind::Special, false, false),
    spec("workitems", CommandKind::Special, false, false),
    spec("reindex", CommandKind::Special, true, false),
    spec("ingeststatus", CommandKind::Special, true, false),
    spec("generate", CommandKind::Special, false, true),
    spec("ask", CommandKind::Router, false, false),
    spec("analyst", CommandKind::Router, false, false),
    spec("agent", CommandKind::Router, false, false),
    spec("intsum", CommandKind::Router, false, false),
    spec("aar", CommandKind::Router, false, false),
];

const fn spec(name: &'static str, kind: CommandKind, admin: bool, audio: bool) -> CommandSpec {
    CommandSpec {
        name,
        kind,
        admin,
        audio,
        llm_tool: None,
    }
}

const fn spec_llm(
    name: &'static str,
    kind: CommandKind,
    admin: bool,
    audio: bool,
    llm_tool: &'static str,
) -> CommandSpec {
    CommandSpec {
        name,
        kind,
        admin,
        audio,
        llm_tool: Some(llm_tool),
    }
}

const ADMIN_TOKENS: &[&str] = &["radio.power", "workorder.clear", "ships.org"];

pub fn public_commands() -> HashSet<&'static str> {
    COMMAND_MANIFEST
        .iter()
        .filter(|c| !c.admin)
        .map(|c| c.name)
        .collect()
}

pub fn admin_commands() -> HashSet<&'static str> {
    COMMAND_MANIFEST
        .iter()
        .filter(|c| c.admin)
        .map(|c| c.name)
        .chain(ADMIN_TOKENS.iter().copied())
        .collect()
}

pub fn audio_commands() -> HashSet<&'static str> {
    COMMAND_MANIFEST
        .iter()
        .filter(|c| c.audio)
        .map(|c| c.name)
        .collect()
}

pub fn is_known_command(name: &str) -> bool {
    public_commands().contains(name) || admin_commands().contains(name)
}

pub fn is_admin_command(name: &str) -> bool {
    admin_commands().contains(name)
}

pub fn is_audio_command(name: &str) -> bool {
    audio_commands().contains(name)
}

#[derive(Debug, Clone)]
pub struct ParsedCommand {
    pub name: String,
    pub args: String,
    pub raw_args: Vec<String>,
    pub flags: HashSet<char>,
}

/// Common karaoke misspellings — `!karyoke` must not fall through to LLM.
pub fn karaoke_alias(name: &str) -> Option<&'static str> {
    Some(match name {
        "karyoke" | "kareoke" | "karaok" | "karaokee" | "karaokay" | "karaokey"
        | "carryoke" | "carioke" | "karoke" | "karaoake" => "karaoke",
        _ => return None,
    })
}

pub fn parse_command(
    message: &str,
    prefix: &str,
    aliases: &HashMap<String, String>,
) -> Option<ParsedCommand> {
    let trimmed = message.trim();
    if !trimmed.starts_with(prefix) {
        return None;
    }
    let without = &trimmed[prefix.len()..];
    if without.is_empty() {
        return None;
    }
    let parts: Vec<&str> = without.split_whitespace().collect();
    let mut name = parts[0]
        .trim_end_matches(|c: char| matches!(c, '.' | ',' | '!' | '?' | ';' | ':'))
        .to_lowercase();
    if let Some(alias) = aliases.get(&name) {
        name = alias.clone();
    } else if let Some(k) = karaoke_alias(&name) {
        name = k.to_string();
    }
    let mut flags = HashSet::new();
    let mut arg_parts = Vec::new();
    for p in parts.iter().skip(1) {
        let b = p.as_bytes();
        if b.len() == 2 && b[0] == b'-' && b[1].is_ascii_alphabetic() {
            flags.insert((b[1] as char).to_ascii_lowercase());
        } else {
            arg_parts.push((*p).to_string());
        }
    }
    Some(ParsedCommand {
        name,
        args: arg_parts.join(" "),
        raw_args: arg_parts,
        flags,
    })
}

pub fn default_aliases() -> HashMap<String, String> {
    HashMap::from([
        ("p".into(), "play".into()),
        ("s".into(), "skip".into()),
        ("n".into(), "skip".into()),
        ("karyoke".into(), "karaoke".into()),
        ("kareoke".into(), "karaoke".into()),
        ("karoke".into(), "karaoke".into()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple() {
        let r = parse_command("!play Bohemian Rhapsody", "!", &HashMap::new()).unwrap();
        assert_eq!(r.name, "play");
        assert_eq!(r.args, "Bohemian Rhapsody");
        assert_eq!(r.raw_args, ["Bohemian", "Rhapsody"]);
    }

    #[test]
    fn parses_flags() {
        let r = parse_command("!play -y Hotel California", "!", &HashMap::new()).unwrap();
        assert!(r.flags.contains(&'y'));
        assert_eq!(r.args, "Hotel California");
    }

    #[test]
    fn non_command_is_none() {
        assert!(parse_command("hello world", "!", &HashMap::new()).is_none());
        assert!(parse_command("", "!", &HashMap::new()).is_none());
    }

    #[test]
    fn karaoke_typos_map() {
        let r = parse_command("!karyoke on", "!", &HashMap::new()).unwrap();
        assert_eq!(r.name, "karaoke");
        assert_eq!(r.args, "on");
        let r = parse_command("!karoke", "!", &HashMap::new()).unwrap();
        assert_eq!(r.name, "karaoke");
    }

    #[test]
    fn custom_prefix() {
        let r = parse_command("/play test", "/", &HashMap::new()).unwrap();
        assert_eq!(r.name, "play");
        assert_eq!(r.args, "test");
    }

    #[test]
    fn aliases() {
        let r = parse_command("!p Stairway to Heaven", "!", &default_aliases()).unwrap();
        assert_eq!(r.name, "play");
        assert_eq!(r.args, "Stairway to Heaven");
    }

    #[test]
    fn no_args() {
        let r = parse_command("!pause", "!", &HashMap::new()).unwrap();
        assert_eq!(r.name, "pause");
        assert!(r.args.is_empty());
    }

    #[test]
    fn chevron7_known() {
        let r = parse_command("!chevron7", "!", &HashMap::new()).unwrap();
        assert_eq!(r.name, "chevron7");
        assert!(is_known_command("chevron7"));
    }

    #[test]
    fn frozen_names_include_phase2() {
        for n in ["play", "skip", "queue", "ask", "analyst"] {
            assert!(is_known_command(n), "missing {n}");
        }
        assert!(COMMAND_MANIFEST.len() >= 60);
    }
}
