//! Command building & parsing — mirrors `teamspeak-js/src/command/`

use std::collections::HashMap;

use crate::types::EscapedString;

const ESCAPE_MAP: &[(char, &str)] = &[
    ('\\', "\\\\"),
    ('/', "\\/"),
    (' ', "\\s"),
    ('|', "\\p"),
    ('\x07', "\\a"),
    ('\x08', "\\b"),
    ('\x0C', "\\f"),
    ('\n', "\\n"),
    ('\r', "\\r"),
    ('\t', "\\t"),
    ('\x0B', "\\v"),
];

pub fn escape(s: &str) -> EscapedString {
    let mut result = s.to_string();
    for &(from, to) in ESCAPE_MAP {
        result = result.replace(from, to);
    }
    EscapedString(result)
}

pub fn unescape(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('\\') => result.push('\\'),
                Some('/') => result.push('/'),
                Some('s') => result.push(' '),
                Some('p') => result.push('|'),
                Some('a') => result.push('\x07'),
                Some('b') => result.push('\x08'),
                Some('f') => result.push('\x0C'),
                Some('n') => result.push('\n'),
                Some('r') => result.push('\r'),
                Some('t') => result.push('\t'),
                Some('v') => result.push('\x0B'),
                Some(next) => { result.push('\\'); result.push(next); }
                None => { result.push('\\'); }
            }
        } else {
            result.push(c);
        }
    }
    result
}

#[derive(Debug, Clone)]
pub struct Command {
    pub name: String,
    pub params: HashMap<String, String>,
}

pub fn build_command(cmd: &str, params: HashMap<String, String>) -> String {
    let mut parts: Vec<String> = vec![escape(cmd).0];
    for (k, v) in params {
        parts.push(format!("{}={}", k, escape(&v).0));
    }
    parts.join(" ")
}

pub fn build_command_ordered(cmd: &str, params: &[(&str, &str)]) -> String {
    let mut parts: Vec<String> = vec![escape(cmd).0];
    for (k, v) in params {
        parts.push(format!("{}={}", k, escape(v).0));
    }
    parts.join(" ")
}

pub fn parse_command(s: &str) -> Option<Command> {
    if s.is_empty() {
        return None;
    }

    // Skip leading non-printable bytes (< 0x20 or > 0x7E)
    let start = s.find(|c: char| c as u32 >= 0x20 && c as u32 <= 0x7E).unwrap_or(0);
    let s = &s[start..];

    let parts: Vec<&str> = s.split(' ').collect();
    if parts.is_empty() {
        return None;
    }

    let name = parts[0].to_string();
    if name.is_empty() {
        return None;
    }

    let mut params = HashMap::new();
    for p in &parts[1..] {
        if p.is_empty() {
            continue;
        }
        if let Some(eq_idx) = p.find('=') {
            let k = unescape(&p[..eq_idx]);
            let v = unescape(&p[eq_idx + 1..]);
            params.insert(k, v);
        } else {
            params.insert(unescape(p), String::new());
        }
    }

    Some(Command { name, params })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_escape_roundtrip() {
        let input = "hello world | test\\foo/bar\nnewline";
        let escaped = escape(input);
        let unescaped = unescape(&escaped.0);
        assert_eq!(input, unescaped);
    }

    #[test]
    fn test_build_command() {
        let mut params = HashMap::new();
        params.insert("msg".to_string(), "hello world".to_string());
        params.insert("target".to_string(), "1".to_string());
        let cmd = build_command("sendtextmessage", params);
        assert!(cmd.starts_with("sendtextmessage"));
        assert!(cmd.contains("msg=hello\\sworld"));
        assert!(cmd.contains("target=1"));
    }

    #[test]
    fn test_parse_command() {
        let cmd = parse_command("clientinfo clid=100").unwrap();
        assert_eq!(cmd.name, "clientinfo");
        assert_eq!(cmd.params.get("clid").unwrap(), "100");
    }

    #[test]
    fn test_parse_command_skip_non_printable() {
        let input = "\x00\x01\x02clientinfo clid=100";
        let cmd = parse_command(input).unwrap();
        assert_eq!(cmd.name, "clientinfo");
    }

    #[test]
    fn test_parse_command_empty() {
        assert!(parse_command("").is_none());
    }
}
