// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! SSRF guard for URLs passed to ffmpeg / yt-dlp.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};

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

fn ip_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => is_private_ipv4(v.octets()),
        IpAddr::V6(v) => ipv6_blocked(v),
    }
}

fn ipv6_blocked(v: Ipv6Addr) -> bool {
    if let Some(v4) = v.to_ipv4_mapped() {
        return is_private_ipv4(v4.octets());
    }
    // Deprecated IPv4-compatible (::1.2.3.4) and other embedded v4.
    if let Some(v4) = v.to_ipv4() {
        if is_private_ipv4(v4.octets()) {
            return true;
        }
    }
    v.is_loopback()
        || v.is_unspecified()
        || v.is_multicast()
        || v.is_unique_local()
        || v.is_unicast_link_local()
}

fn host_to_ip(host: &str) -> Option<IpAddr> {
    let h = host.trim_matches(|c| c == '[' || c == ']');
    if let Ok(ip) = h.parse::<IpAddr>() {
        return Some(ip);
    }
    if let Some(o) = parse_ipv4(h) {
        return Some(IpAddr::V4(Ipv4Addr::new(o[0], o[1], o[2], o[3])));
    }
    // Decimal IPv4 (ffmpeg/curl treat http://2130706433/ as 127.0.0.1).
    if !h.is_empty() && h.chars().all(|c| c.is_ascii_digit()) {
        if let Ok(n) = h.parse::<u32>() {
            return Some(IpAddr::V4(Ipv4Addr::from(n)));
        }
    }
    None
}

fn host_blocked_literal(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if h.is_empty() {
        return true;
    }
    if BLOCKED_HOSTNAMES.contains(&h.as_str()) {
        return true;
    }
    if let Some(ip) = host_to_ip(&h) {
        return ip_blocked(ip);
    }
    false
}

/// Absolute http(s), no userinfo, host is not a private/reserved literal.
pub fn parse_http_host(input: &str) -> Option<(String, String)> {
    let t = input.trim();
    let u = reqwest::Url::parse(t).ok()?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    if !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    let host = u.host_str()?.trim().to_string();
    if host.is_empty() {
        return None;
    }
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
    if host_to_ip(&host).is_some() {
        return true;
    }
    let lookup = format!("{host}:443").to_socket_addrs();
    let Ok(addrs) = lookup else {
        return false;
    };
    let mut any = false;
    for a in addrs {
        any = true;
        if ip_blocked(a.ip()) {
            return false;
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
        assert!(is_public_playback_url(
            "https://www.youtube.com/watch?v=hLOheGDwD_0"
        ));
    }

    #[test]
    fn rejects_userinfo_and_at_tricks() {
        assert!(!is_public_playback_url(
            "https://www.youtube.com:443@127.0.0.1/watch?v=x"
        ));
        assert!(!is_public_playback_url("http://user:pass@example.com/x"));
        assert!(!is_public_playback_url("http://127.0.0.1@example.com/x"));
        assert!(!is_public_playback_url("http://user@127.0.0.1/x"));
    }

    #[test]
    fn rejects_mapped_ipv6_and_unspecified() {
        assert!(!is_public_playback_url("http://[::ffff:127.0.0.1]/x"));
        assert!(!is_public_playback_url("http://[::ffff:169.254.169.254]/"));
        assert!(!is_public_playback_url("http://[::1]/x"));
        assert!(!is_public_playback_url("http://[::]/x"));
        assert!(!is_public_playback_url("http://[fc00::1]/x"));
        assert!(!is_public_playback_url("http://[fe80::1]/x"));
        assert!(!assert_public_playback_url("http://[::ffff:127.0.0.1]/a.mp3"));
        assert!(!assert_public_playback_url(
            "http://[::ffff:169.254.169.254]/"
        ));
    }

    #[test]
    fn rejects_decimal_ipv4() {
        // 127.0.0.1
        assert!(!is_public_playback_url("http://2130706433/x"));
    }
}
