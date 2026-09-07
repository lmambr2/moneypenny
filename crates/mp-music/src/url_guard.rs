// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! SSRF guard for URLs passed to ffmpeg / yt-dlp.

use std::net::{IpAddr, ToSocketAddrs};

const BLOCKED_HOSTNAMES: &[&str] = &[
    "localhost",
    "qdrant",
    "ollama",
    "bot",
    "rkllama",
    "stt-mock",
    "stt-whisper",
    "piper-tts",
    "mempalace-bridge",
    "tidal-bridge",
    "spotify-bridge",
    "ace-step",
    "teamspeak",
    "host.docker.internal",
    "metadata.google.internal",
    "metadata",
];

fn parse_ipv4(host: &str) -> Option<[u8; 4]> {
    let mut out = [0u8; 4];
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    for (i, p) in parts.iter().enumerate() {
        if !p.chars().all(|c| c.is_ascii_digit()) || p.len() > 3 {
            return None;
        }
        let n: u16 = p.parse().ok()?;
        if n > 255 {
            return None;
        }
        out[i] = n as u8;
    }
    Some(out)
}

fn is_private_ipv4(o: [u8; 4]) -> bool {
    let [a, b, ..] = o;
    a == 0
        || a == 10
        || a == 127
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 100 && (64..=127).contains(&b))
        || (a == 198 && (b == 18 || b == 19))
        || a >= 224
}

fn is_blocked_ipv6(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if h == "::1" || h == "0:0:0:0:0:0:0:1" {
        return true;
    }
    if h.starts_with("fe80:") || h.starts_with("ff") {
        return true;
    }
    if h.starts_with("fc") || h.starts_with("fd") {
        return true;
    }
    false
}

fn host_blocked_literal(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if h.is_empty() {
        return true;
    }
    if BLOCKED_HOSTNAMES.contains(&h.as_str()) {
        return true;
    }
    if let Some(o) = parse_ipv4(&h) {
        return is_private_ipv4(o);
    }
    if h.contains(':') {
        return is_blocked_ipv6(&h);
    }
    false
}

fn parse_http_host(input: &str) -> Option<(String, String)> {
    let t = input.trim();
    let rest = t
        .strip_prefix("https://")
        .or_else(|| t.strip_prefix("http://"))?;
    let hostport = rest.split('/').next()?.split('?').next()?.trim();
    if hostport.is_empty() {
        return None;
    }
    let host = if hostport.starts_with('[') {
        let end = hostport.find(']')?;
        hostport[1..end].to_string()
    } else {
        hostport.split(':').next()?.to_string()
    };
    Some((host, t.to_string()))
}

/// Literal-only check (no DNS). http(s) and not a private/reserved host.
pub fn is_public_playback_url(input: &str) -> bool {
    let Some((host, _)) = parse_http_host(input) else {
        return false;
    };
    !host_blocked_literal(&host)
}

/// Also resolve DNS and reject private A/AAAA. Fail-closed on lookup error.
pub fn assert_public_playback_url(input: &str) -> bool {
    if !is_public_playback_url(input) {
        return false;
    }
    let Some((host, _)) = parse_http_host(input) else {
        return false;
    };
    if parse_ipv4(&host).is_some() || host.contains(':') {
        return true;
    }
    let lookup = format!("{host}:443").to_socket_addrs();
    let Ok(addrs) = lookup else {
        return false;
    };
    let mut any = false;
    for a in addrs {
        any = true;
        match a.ip() {
            IpAddr::V4(v) => {
                if is_private_ipv4(v.octets()) {
                    return false;
                }
            }
            IpAddr::V6(v) => {
                if is_blocked_ipv6(&v.to_string()) {
                    return false;
                }
            }
        }
    }
    any
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_loopback_and_file() {
        assert!(!is_public_playback_url("http://127.0.0.1/x"));
        assert!(!is_public_playback_url("http://localhost/x"));
        assert!(!is_public_playback_url("file:///etc/passwd"));
        assert!(!is_public_playback_url("ftp://youtube.com/x"));
        assert!(!is_public_playback_url("http://192.168.1.1/x"));
        assert!(!is_public_playback_url("http://piper-tts/v1"));
    }

    #[test]
    fn allows_public_https() {
        assert!(is_public_playback_url("https://example.com/a.mp3"));
        assert!(is_public_playback_url("https://www.youtube.com/watch?v=hLOheGDwD_0"));
    }
}
