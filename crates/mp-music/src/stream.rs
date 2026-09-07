// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Direct HTTP/Icecast streams. YouTube/X/Bandcamp go through yt-dlp.

use crate::track::{Platform, Track};
use crate::url_guard::{assert_public_playback_url, is_public_playback_url};

fn host_of(input: &str) -> Option<String> {
    let t = input.trim();
    let rest = t
        .strip_prefix("https://")
        .or_else(|| t.strip_prefix("http://"))?;
    let hostport = rest.split('/').next()?.split('?').next()?.trim();
    let host = if hostport.starts_with('[') {
        let end = hostport.find(']')?;
        hostport[1..end].to_ascii_lowercase()
    } else {
        let h = hostport.split(':').next()?.to_ascii_lowercase();
        h.strip_prefix("www.").unwrap_or(&h).to_string()
    };
    Some(host)
}

fn host_matches(input: &str, tails: &[&str]) -> bool {
    let Some(h) = host_of(input) else {
        return false;
    };
    tails.iter().any(|t| h == *t || h.ends_with(&format!(".{t}")))
}

pub fn is_youtube_url(input: &str) -> bool {
    host_matches(input, &["youtube.com", "youtu.be", "youtube-nocookie.com"])
}

pub fn is_x_twitter_url(input: &str) -> bool {
    host_matches(input, &["twitter.com", "x.com", "t.co"])
}

pub fn is_bandcamp_url(input: &str) -> bool {
    host_matches(input, &["bandcamp.com"])
}

pub fn is_spotify_ref(input: &str) -> bool {
    let s = input.trim();
    if s.starts_with("spotify:track:") || s.starts_with("spotify:playlist:") || s.starts_with("spotify:album:")
    {
        return true;
    }
    host_matches(s, &["open.spotify.com", "spotify.com"])
}

pub fn is_tidal_url(input: &str) -> bool {
    host_matches(input, &["tidal.com", "listen.tidal.com"])
}

/// Direct http(s) stream — not a yt-dlp or DRM site.
pub fn is_streamable_url(input: &str) -> bool {
    if !is_public_playback_url(input) {
        return false;
    }
    !is_youtube_url(input)
        && !is_x_twitter_url(input)
        && !is_bandcamp_url(input)
        && !is_tidal_url(input)
        && !is_spotify_ref(input)
}

pub fn name_from_url(url: &str) -> String {
    let Some((_, path)) = url.split_once("://") else {
        return "Stream".into();
    };
    let path = path.split('?').next().unwrap_or(path);
    let last = path
        .split('/')
        .filter(|s| !s.is_empty())
        .next_back()
        .unwrap_or("");
    if last.is_empty() {
        host_of(url).unwrap_or_else(|| "Stream".into())
    } else {
        urlencoding_decode(last)
    }
}

fn urlencoding_decode(s: &str) -> String {
    let mut out = String::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).ok();
            if let Some(h) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(h as char);
                i += 3;
                continue;
            }
        }
        out.push(b[i] as char);
        i += 1;
    }
    if out.is_empty() {
        "Stream".into()
    } else {
        out
    }
}

pub fn stream_track(url: &str) -> Option<Track> {
    if !is_streamable_url(url) {
        return None;
    }
    Some(Track {
        id: url.trim().to_string(),
        title: name_from_url(url),
        artist: "Stream".into(),
        album: "Stream".into(),
        platform: Platform::Stream,
        url: url.trim().to_string(),
        duration: 0,
        cover_url: String::new(),
    })
}

pub fn stream_playback_url(song_id: &str, stored_url: &str) -> Option<String> {
    let u = if stored_url.starts_with("http://") || stored_url.starts_with("https://") {
        stored_url
    } else {
        song_id
    };
    if !is_streamable_url(u) {
        return None;
    }
    if !assert_public_playback_url(u) {
        tracing::warn!(url = %u.chars().take(80).collect::<String>(), "stream URL failed public DNS check");
        return None;
    }
    Some(u.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_hosts() {
        assert!(is_youtube_url("https://www.youtube.com/watch?v=hLOheGDwD_0"));
        assert!(is_youtube_url("https://youtu.be/hLOheGDwD_0"));
        assert!(is_x_twitter_url("https://x.com/i/status/1"));
        assert!(is_bandcamp_url("https://foo.bandcamp.com/track/bar"));
        assert!(!is_streamable_url("https://www.youtube.com/watch?v=abc"));
        assert!(is_streamable_url("https://example.com/radio.mp3"));
        assert!(!is_streamable_url("http://127.0.0.1/x.mp3"));
        assert!(is_youtube_url("https://www.youtube.com/watch?v=abc"));
        assert!(!is_youtube_url("https://w.youtube.com.evil.example/watch?v=abc"));
    }

    #[test]
    fn names_last_path_segment() {
        assert_eq!(name_from_url("https://ex.com/a/beep.mp3"), "beep.mp3");
    }
}
