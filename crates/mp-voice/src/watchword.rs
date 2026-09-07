// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Wake-phrase gate. No STT garble synonym table — exact verbs only.

use std::collections::{HashMap, HashSet};

use mp_control::{is_known_command, parse_command};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchwordMatch {
    pub matched: bool,
    pub command: String,
}

#[derive(Debug, Clone, Default)]
pub struct WatchwordOptions {
    pub kws_detected: bool,
    pub armed: bool,
    pub text_wake_fallback: bool,
}

const PLAYBACK_VERBS: &[&str] = &[
    "pause", "resume", "skip", "stop", "play", "next", "jump", "go", "prev",
];

const ZERO_ARG_VOICE_COMMANDS: &[&str] = &[
    "pause",
    "resume",
    "skip",
    "stop",
    "next",
    "prev",
    "now",
    "clear",
    "queue",
    "list",
    "lyrics",
    "help",
    "test",
    "roast",
    "roastout",
    "roastin",
    "recall",
    "reindex",
    "ingeststatus",
    "follow",
    "chevron7",
];

const PARTIAL_SAFE_COMMANDS: &[&str] = &[
    "pause", "resume", "skip", "stop", "next", "prev", "vol", "clear", "mode",
];

pub fn normalize_for_watchword(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if matches!(c, '.' | ',' | '!' | '?' | ';' | ':' | '\'' | '"') {
            out.push(' ');
        } else {
            out.extend(c.to_lowercase());
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn normalize_voice_transcript(transcript: &str) -> String {
    let t = transcript.trim();
    t.trim_end_matches(|c: char| matches!(c, '.' | '!' | '?' | ',' | ';' | ':'))
        .trim()
        .to_string()
}

fn parse_norm(transcript: &str) -> String {
    normalize_voice_transcript(transcript)
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_filler_token(w: &str) -> bool {
    let l = w.to_ascii_lowercase();
    match l.as_str() {
        "a" | "an" | "the" => true,
        s if s.starts_with("uh") && s.len() >= 2 && s.bytes().skip(2).all(|b| b == b'h') => true,
        s if s.starts_with("um") && s.len() >= 2 && s.bytes().skip(2).all(|b| b == b'm') => true,
        _ => false,
    }
}

fn strip_leading_filler(text: &str) -> String {
    let mut parts: Vec<&str> = text.split_whitespace().collect();
    while parts.first().is_some_and(|w| is_filler_token(w)) {
        parts.remove(0);
    }
    parts.join(" ")
}

pub fn normalize_voice_command(command: &str) -> String {
    let trimmed = command
        .trim_start_matches(|c: char| matches!(c, ',' | ':' | ';' | '-' | '–' | '—' | ' ' | '\t'))
        .trim();
    let chunk = trimmed.split([',', ';']).next().unwrap_or("").trim();
    normalize_voice_transcript(&strip_leading_filler(chunk))
}

fn finalize_command(raw: &str) -> String {
    normalize_voice_command(raw)
}

fn finalize_command_segment(raw: &str) -> String {
    let trimmed = raw
        .trim_start_matches(|c: char| matches!(c, ',' | ':' | ';' | '-' | '–' | '—' | ' ' | '\t'))
        .trim();
    let chunk = trimmed.split([',', ';']).next().unwrap_or("").trim();
    let stripped = strip_leading_filler(chunk);
    if stripped.is_empty() {
        return String::new();
    }
    normalize_voice_transcript(&stripped)
}

pub fn watchword_aliases(watchword: &str) -> Vec<String> {
    let base = normalize_for_watchword(watchword);
    if base.is_empty() {
        return Vec::new();
    }
    let mut aliases = vec![base.clone()];
    let parts: Vec<&str> = base.split_whitespace().collect();
    if parts.len() == 1 && parts[0].len() >= 8 {
        let w = parts[0];
        if let Some(split) = split_penny(w) {
            aliases.push(split);
        }
    }
    aliases.sort_by(|a, b| b.len().cmp(&a.len()).then(a.cmp(b)));
    aliases.dedup();
    aliases
}

fn split_penny(word: &str) -> Option<String> {
    for end in ["penny", "penney"] {
        if let Some(prefix) = word.strip_suffix(end) {
            if prefix.len() >= 3 && prefix.chars().all(|c| c.is_ascii_lowercase()) {
                return Some(format!("{prefix} {end}"));
            }
        }
    }
    None
}

fn is_sep(c: char) -> bool {
    matches!(c, ' ' | ',' | ';' | ':')
}

/// Match alias at the start of `norm`. Multi-word aliases allow commas between tokens.
fn match_alias_prefix(norm: &str, alias: &str) -> Option<String> {
    let parts: Vec<&str> = alias.split_whitespace().filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return None;
    }
    let mut rest = norm;
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            let trimmed = rest.trim_start_matches(is_sep);
            if trimmed.len() == rest.len() {
                return None;
            }
            rest = trimmed;
        }
        if rest.len() < part.len() || !rest[..part.len()].eq_ignore_ascii_case(part) {
            return None;
        }
        rest = &rest[part.len()..];
    }
    if rest.is_empty() {
        return Some(String::new());
    }
    let first = rest.chars().next()?;
    if is_sep(first) {
        Some(rest.trim_start_matches(is_sep).to_string())
    } else {
        None
    }
}

fn strip_watchword_prefix(norm: &str, watchword: &str) -> Option<String> {
    for alias in watchword_aliases(watchword) {
        if let Some(rest) = match_alias_prefix(norm, &alias) {
            return Some(rest);
        }
    }
    None
}

fn alias_infix_after(norm: &str, watchword: &str) -> Option<String> {
    for alias in watchword_aliases(watchword) {
        if let Some(rest) = match_alias_prefix(norm, &alias) {
            return Some(rest);
        }
        let mut idx = 0;
        let bytes = norm.as_bytes();
        while idx < bytes.len() {
            if is_sep(bytes[idx] as char) {
                let next = idx + 1;
                let slice = &norm[next..];
                let trimmed = slice.trim_start_matches(is_sep);
                if let Some(rest) = match_alias_prefix(trimmed, &alias) {
                    return Some(rest);
                }
            }
            idx += 1;
        }
    }
    None
}

pub fn voice_command_shape_ok(name: &str, args: &str) -> bool {
    let a = args.trim();
    if ZERO_ARG_VOICE_COMMANDS.contains(&name) {
        return a.is_empty();
    }
    if name == "forget" {
        return a == "all" || a.chars().all(|c| c.is_ascii_digit()) && !a.is_empty();
    }
    if name == "remember" {
        let words = a.split_whitespace().filter(|w| !w.is_empty()).count();
        return words >= 2 || a.len() >= 8;
    }
    if name == "vol" {
        return a.len() <= 3 && !a.is_empty() && a.chars().all(|c| c.is_ascii_digit());
    }
    if name == "mode" {
        return matches!(
            a.to_ascii_lowercase().as_str(),
            "seq" | "loop" | "random" | "rloop"
        );
    }
    if name == "karaoke" {
        return a.is_empty()
            || matches!(a.to_ascii_lowercase().as_str(), "on" | "off" | "status");
    }
    if name == "rate" || name == "unrate" {
        return a.is_empty() || matches!(a, "1" | "2" | "3" | "4" | "5");
    }
    true
}

pub fn is_actionable_voice_command(command: &str, aliases: &HashMap<String, String>) -> bool {
    let text = command.trim();
    if text.is_empty() {
        return false;
    }
    let Some(parsed) = parse_command(&format!("!{text}"), "!", aliases) else {
        return false;
    };
    let name = parsed
        .name
        .trim_end_matches(|c: char| matches!(c, '.' | ',' | '!' | '?' | ';' | ':'));
    if !is_known_command(name) {
        return false;
    }
    voice_command_shape_ok(name, &parsed.args)
}

pub fn is_partial_safe_voice_command(command: &str, aliases: &HashMap<String, String>) -> bool {
    if !is_actionable_voice_command(command, aliases) {
        return false;
    }
    let Some(parsed) = parse_command(&format!("!{}", command.trim()), "!", aliases) else {
        return false;
    };
    let name = parsed
        .name
        .trim_end_matches(|c: char| matches!(c, '.' | ',' | '!' | '?' | ';' | ':'));
    PARTIAL_SAFE_COMMANDS.contains(&name) && parsed.args.trim().is_empty()
}

pub fn partial_mentions_command(partial: &str, command: &str) -> bool {
    let verb = command
        .trim()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if verb.is_empty() {
        return false;
    }
    partial
        .to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|w| w == verb)
}

fn resolve_playback_verb_token(token: &str) -> Option<&'static str> {
    let key = token
        .trim_matches(|c: char| matches!(c, '.' | ',' | '!' | '?' | ';' | ':' | '\'' | '"'))
        .to_ascii_lowercase();
    PLAYBACK_VERBS.iter().copied().find(|v| *v == key)
}

fn extract_playback_verb(tokens: &[&str]) -> String {
    if tokens.is_empty() {
        return String::new();
    }
    let cleaned: Vec<String> = tokens
        .iter()
        .map(|t| {
            t.trim_matches(|c: char| matches!(c, '.' | ',' | '!' | '?' | ';' | ':' | '\'' | '"'))
                .to_ascii_lowercase()
        })
        .filter(|s| !s.is_empty())
        .collect();
    if cleaned.is_empty() {
        return String::new();
    }

    if cleaned.len() <= 5 {
        for i in (0..tokens.len()).rev() {
            if let Some(verb) = resolve_playback_verb_token(tokens[i]) {
                if verb == "play" {
                    let play = finalize_command_segment(&tokens[i..].join(" "));
                    let rest: String = play.split_whitespace().skip(1).collect();
                    if rest.is_empty() {
                        return "play".into();
                    }
                    return play;
                }
                return verb.to_string();
            }
        }
        return String::new();
    }

    for i in (0..cleaned.len()).rev() {
        if resolve_playback_verb_token(&cleaned[i]) != Some("play") {
            continue;
        }
        if i >= cleaned.len() - 1 {
            continue;
        }
        return finalize_command_segment(&tokens[i..].join(" "));
    }

    if resolve_playback_verb_token(&cleaned[0]) == Some("play") && cleaned.len() > 1 {
        return finalize_command_segment(&tokens.join(" "));
    }
    String::new()
}

pub fn extract_command_segment(transcript: &str, watchword: &str) -> String {
    let norm = parse_norm(transcript);
    if norm.is_empty() {
        return String::new();
    }
    let empty = HashMap::new();

    if let Some(rest) = strip_watchword_prefix(&norm, watchword) {
        if !rest.is_empty() {
            let tokens: Vec<&str> = rest.split_whitespace().collect();
            let verb = extract_playback_verb(&tokens);
            if !verb.is_empty() && (verb == "play" || is_actionable_voice_command(&verb, &empty)) {
                return verb;
            }
            let seg = finalize_command_segment(&rest);
            if !seg.is_empty() && is_actionable_voice_command(&seg, &empty) {
                return seg;
            }
            return String::new();
        }
    }

    if let Some(after) = alias_infix_after(&norm, watchword) {
        if !after.is_empty() {
            let tokens: Vec<&str> = after.split_whitespace().collect();
            let verb = extract_playback_verb(&tokens);
            if !verb.is_empty() && (verb == "play" || is_actionable_voice_command(&verb, &empty)) {
                return verb;
            }
            let seg = finalize_command_segment(&after);
            if !seg.is_empty() && is_actionable_voice_command(&seg, &empty) {
                return seg;
            }
        }
        return String::new();
    }

    let tokens: Vec<&str> = norm.split_whitespace().collect();
    let verb = extract_playback_verb(&tokens);
    if !verb.is_empty() && is_actionable_voice_command(&verb, &empty) {
        return verb;
    }
    if verb == "play" {
        return "play".into();
    }
    let seg = finalize_command_segment(&norm);
    if !seg.is_empty() && is_actionable_voice_command(&seg, &empty) {
        return seg;
    }
    String::new()
}

pub fn extract_watchword_command(
    transcript: &str,
    watchword: &str,
    opts: WatchwordOptions,
) -> WatchwordMatch {
    let norm = parse_norm(transcript);

    if opts.kws_detected || opts.text_wake_fallback {
        if let Some(rest) = strip_watchword_prefix(&norm, watchword) {
            let command = if opts.kws_detected || opts.armed {
                finalize_command_segment(&rest)
            } else {
                finalize_command(&rest)
            };
            return WatchwordMatch {
                matched: true,
                command,
            };
        }
        if opts.kws_detected {
            return WatchwordMatch {
                matched: true,
                command: if norm.is_empty() {
                    String::new()
                } else {
                    extract_command_segment(transcript, watchword)
                },
            };
        }
    }

    if opts.armed {
        return WatchwordMatch {
            matched: true,
            command: if norm.is_empty() {
                String::new()
            } else {
                extract_command_segment(transcript, watchword)
            },
        };
    }

    WatchwordMatch {
        matched: false,
        command: String::new(),
    }
}

pub fn is_music_search_route_text(text: &str, aliases: &HashMap<String, String>) -> bool {
    let Some(parsed) = parse_command(&format!("!{}", text.trim()), "!", aliases) else {
        return false;
    };
    matches!(
        parsed.name.as_str(),
        "play" | "add" | "playnext" | "pn" | "playlist" | "album"
    )
}

pub fn is_playback_start_reply(reply: Option<&str>) -> bool {
    reply
        .map(|r| r.to_ascii_lowercase().contains("now playing"))
        .unwrap_or(false)
}

pub fn is_playback_control_reply(reply: Option<&str>) -> bool {
    let Some(r) = reply.map(|s| s.to_ascii_lowercase()) else {
        return false;
    };
    r == "paused" || r == "resumed" || r.starts_with("stopped") || r.starts_with("skipped")
}

pub fn voice_reply_clears_saved_music(reply: Option<&str>) -> bool {
    let Some(r) = reply.map(|s| s.to_ascii_lowercase()) else {
        return false;
    };
    let t = r.trim();
    t.starts_with("stopped") || t == "paused" || t == "paused."
}

pub fn voice_spoken_ack(reply: Option<&str>) -> Option<&'static str> {
    let r = reply?.to_ascii_lowercase();
    let t = r.trim();
    if t == "paused" || t == "paused." {
        return Some("Paused.");
    }
    if t == "resumed" || t == "playback resumed." || t == "playback resumed" {
        return Some("Resumed.");
    }
    if t.starts_with("stopped") {
        return Some("Stopped.");
    }
    if t.starts_with("skipped") {
        return Some("Skipped.");
    }
    None
}

pub fn should_speak_voice_reply(reply: &str, max_chars: usize) -> bool {
    if is_playback_start_reply(Some(reply)) {
        return false;
    }
    if voice_spoken_ack(Some(reply)).is_some() {
        return true;
    }
    reply.len() <= max_chars
}

#[allow(dead_code)]
fn _zero_arg_set() -> HashSet<&'static str> {
    ZERO_ARG_VOICE_COMMANDS.iter().copied().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty() -> HashMap<String, String> {
        HashMap::new()
    }

    fn ww(text: &str, opts: WatchwordOptions) -> WatchwordMatch {
        extract_watchword_command(text, "moneypenny", opts)
    }

    #[test]
    fn extracts_command_after_watchword() {
        assert_eq!(
            ww(
                "Moneypenny pause",
                WatchwordOptions {
                    text_wake_fallback: true,
                    ..Default::default()
                }
            ),
            WatchwordMatch {
                matched: true,
                command: "pause".into()
            }
        );
    }

    #[test]
    fn accepts_space_split_watchword() {
        assert_eq!(
            ww(
                "money penny skip",
                WatchwordOptions {
                    text_wake_fallback: true,
                    ..Default::default()
                }
            )
            .command,
            "skip"
        );
    }

    #[test]
    fn routes_on_kws_when_stt_drops_wake() {
        assert_eq!(
            ww(
                "pause",
                WatchwordOptions {
                    kws_detected: true,
                    ..Default::default()
                }
            ),
            WatchwordMatch {
                matched: true,
                command: "pause".into()
            }
        );
    }

    #[test]
    fn watchword_only_kws_empty_stt() {
        assert_eq!(
            ww(
                "",
                WatchwordOptions {
                    kws_detected: true,
                    ..Default::default()
                }
            ),
            WatchwordMatch {
                matched: true,
                command: String::new()
            }
        );
    }

    #[test]
    fn no_false_positive_on_banter() {
        assert!(!ww("You've never heard of the song.", Default::default()).matched);
        assert!(!ww("Why do you pay any pause?", Default::default()).matched);
    }

    #[test]
    fn armed_follow_up() {
        let m = ww(
            "pause",
            WatchwordOptions {
                armed: true,
                ..Default::default()
            },
        );
        assert_eq!(m.command, "pause");
        assert_eq!(extract_command_segment("Pause.", "moneypenny"), "pause");
        assert_eq!(
            ww(
                "Resume.",
                WatchwordOptions {
                    armed: true,
                    ..Default::default()
                }
            )
            .command,
            "resume"
        );
        assert!(partial_mentions_command("Resume.", "resume"));
    }

    #[test]
    fn keeps_play_args() {
        assert_eq!(
            extract_command_segment("Play bohemian rap.", "moneypenny"),
            "play bohemian rap"
        );
    }

    #[test]
    fn no_garble_synonyms() {
        assert_eq!(extract_command_segment("Money peri, France, and.", "moneypenny"), "");
        assert_eq!(extract_command_segment("Honey penny pass.", "moneypenny"), "");
    }

    #[test]
    fn extracts_pause_after_noise() {
        assert_eq!(extract_command_segment("Any pause?", "moneypenny"), "pause");
    }

    #[test]
    fn ignores_without_watchword() {
        assert!(!ww("pause", Default::default()).matched);
    }

    #[test]
    fn watchword_only_text_fallback() {
        assert_eq!(
            ww(
                "Moneypenny",
                WatchwordOptions {
                    text_wake_fallback: true,
                    ..Default::default()
                }
            ),
            WatchwordMatch {
                matched: true,
                command: String::new()
            }
        );
    }

    #[test]
    fn normalize_strips_articles() {
        assert_eq!(normalize_voice_command("a resume"), "resume");
        assert_eq!(normalize_voice_command("the pause"), "pause");
        assert_eq!(normalize_voice_command("peri"), "peri");
        assert_eq!(normalize_voice_command("pass"), "pass");
    }

    #[test]
    fn partial_safe() {
        assert!(is_partial_safe_voice_command("pause", &empty()));
        assert!(!is_partial_safe_voice_command("play toto africa", &empty()));
        assert!(!is_partial_safe_voice_command("now", &empty()));
        assert!(!is_partial_safe_voice_command("queue", &empty()));
    }

    #[test]
    fn actionable() {
        assert!(is_actionable_voice_command("pause", &empty()));
        assert!(is_actionable_voice_command("stop", &empty()));
        assert!(is_actionable_voice_command("play toto africa", &empty()));
        assert!(!is_actionable_voice_command("awesome", &empty()));
        assert!(!is_actionable_voice_command("you", &empty()));
        assert!(!is_actionable_voice_command("now i need to go to a room", &empty()));
        assert!(!is_actionable_voice_command(
            "forget it. i think the problem is she's slow",
            &empty()
        ));
        assert!(is_actionable_voice_command("forget all", &empty()));
        assert!(is_actionable_voice_command("forget 3", &empty()));
        assert!(is_actionable_voice_command("recall", &empty()));
        assert!(!is_actionable_voice_command("remember", &empty()));
        assert!(!is_actionable_voice_command("remember jazz", &empty()));
        assert!(is_actionable_voice_command("remember I like jazz", &empty()));
        assert!(is_actionable_voice_command("remember callsign raven", &empty()));
    }

    #[test]
    fn extract_false_positives() {
        assert_eq!(
            extract_command_segment(
                "I mean that's like the easiest way. There's also like a pod on should.",
                "moneypenny"
            ),
            ""
        );
        assert_eq!(
            extract_command_segment("Money Penny, play Toto Africa.", "moneypenny"),
            "play toto africa"
        );
        assert_eq!(
            extract_command_segment("Now I need to go to a room.", "moneypenny"),
            ""
        );
    }

    #[test]
    fn aliases_exact_and_split() {
        let a = watchword_aliases("moneypenny");
        assert!(a.iter().any(|s| s == "moneypenny"));
        assert!(a.iter().any(|s| s == "money penny"));
        assert!(!a.iter().any(|s| s == "money petty"));
    }

    #[test]
    fn filler_resume_after_split_wake() {
        let m = ww(
            "Money, Penny, a resume.",
            WatchwordOptions {
                text_wake_fallback: true,
                ..Default::default()
            },
        );
        assert!(m.matched);
        assert_eq!(m.command, "resume");
    }
}
