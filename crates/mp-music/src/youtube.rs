// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! YouTube / X / Bandcamp via yt-dlp. CDN URL is resolved at play time.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;

use crate::blacklist::extract_video_id;
use crate::stream::{is_bandcamp_url, is_x_twitter_url, is_youtube_url};
use crate::track::{Platform, Track};
use crate::url_guard::{assert_public_playback_url, is_public_playback_url};

pub const YOUTUBE_MAX_DURATION_SEC: u32 = 15 * 60;
pub const DEFAULT_DEMO_VIDEO_ID: &str = "hLOheGDwD_0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum YoutubePolicy {
    Search,
    Radio,
    Explicit,
}

#[derive(Clone)]
pub struct YoutubeClient {
    bin: Option<PathBuf>,
}

impl Default for YoutubeClient {
    fn default() -> Self {
        Self::new()
    }
}

impl YoutubeClient {
    pub fn new() -> Self {
        Self {
            bin: find_yt_dlp(),
        }
    }

    pub fn available(&self) -> bool {
        self.bin.is_some()
    }

    pub fn can_handle(query: &str) -> bool {
        is_youtube_url(query) || is_x_twitter_url(query) || is_bandcamp_url(query)
    }

    pub fn search(&self, query: &str, limit: usize, policy: YoutubePolicy) -> Vec<Track> {
        let Some(bin) = self.bin.as_ref() else {
            return Vec::new();
        };
        let q = query.trim();
        if q.is_empty() {
            return Vec::new();
        }
        if Self::can_handle(q) {
            let Some(safe) = safe_yt_dlp_media_url(q) else {
                return Vec::new();
            };
            let args = vec![
                safe,
                "--dump-json".into(),
                "--no-warnings".into(),
                "--quiet".into(),
                "--no-playlist".into(),
            ];
            let raw = match run_yt_dlp(bin, &args, Duration::from_secs(45)) {
                Some(s) => s,
                None => return Vec::new(),
            };
            let line = raw.trim().lines().next().unwrap_or("");
            if let Some(t) = parse_entry(line, YoutubePolicy::Explicit) {
                return vec![t];
            }
            return Vec::new();
        }
        if policy == YoutubePolicy::Explicit {
            // Text search still uses search gates.
        }
        let n = limit.clamp(1, 20);
        let args = vec![
            format!("ytsearch{n}:{q}"),
            "--dump-json".into(),
            "--no-warnings".into(),
            "--quiet".into(),
            "--no-playlist".into(),
        ];
        let raw = match run_yt_dlp(bin, &args, Duration::from_secs(45)) {
            Some(s) => s,
            None => return Vec::new(),
        };
        raw.trim()
            .lines()
            .filter(|l| !l.is_empty())
            .filter_map(|l| parse_entry(l, policy))
            .collect()
    }

    /// Metadata for a known video id or media page URL (Vue play-by-id).
    /// Content gates off — the user already named this id.
    pub fn detail(&self, song_id: &str) -> Option<Track> {
        let bin = self.bin.as_ref()?;
        let page = media_page_url(song_id)?;
        if page.starts_with("http") && !is_public_playback_url(&page) {
            return None;
        }
        let args = vec![
            page,
            "--dump-json".into(),
            "--no-warnings".into(),
            "--quiet".into(),
            "--no-playlist".into(),
        ];
        let raw = run_yt_dlp(bin, &args, Duration::from_secs(45))?;
        let line = raw.trim().lines().next().unwrap_or("");
        parse_entry(line, YoutubePolicy::Explicit)
    }

    /// Direct audio URL for ffmpeg. `song_id` is a video id or a media page URL.
    pub fn playback_url(&self, song_id: &str) -> Option<String> {
        let bin = self.bin.as_ref()?;
        let page = media_page_url(song_id)?;
        if page.starts_with("http") && !is_public_playback_url(&page) {
            return None;
        }
        let args = vec![
            page,
            "--get-url".into(),
            "-f".into(),
            "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio".into(),
            "--no-warnings".into(),
            "--quiet".into(),
            "--no-playlist".into(),
        ];
        let raw = run_yt_dlp(bin, &args, Duration::from_secs(45))?;
        let audio = raw.trim().lines().next()?.trim().to_string();
        if audio.is_empty() || !assert_public_playback_url(&audio) {
            return None;
        }
        Some(audio)
    }

    /// Download audio as tagged MP3. Never used on the skip path.
    pub fn download_audio_mp3(&self, song_id: &str, out_dir: &Path, base_name: &str) -> Option<String> {
        let bin = self.bin.as_ref()?;
        let page = media_page_url(song_id)?;
        if page.starts_with("http") && !is_public_playback_url(&page) {
            return None;
        }
        let _ = std::fs::create_dir_all(out_dir);
        let template = out_dir.join(format!("{base_name}.%(ext)s"));
        let args = vec![
            page,
            "-x".into(),
            "--audio-format".into(),
            "mp3".into(),
            "--audio-quality".into(),
            "0".into(),
            "--embed-metadata".into(),
            "--embed-thumbnail".into(),
            "--no-playlist".into(),
            "--no-warnings".into(),
            "--quiet".into(),
            "-o".into(),
            template.to_string_lossy().into_owned(),
        ];
        let _ = run_yt_dlp(bin, &args, Duration::from_secs(300))?;
        let final_path = out_dir.join(format!("{base_name}.mp3"));
        if final_path.is_file() {
            Some(final_path.to_string_lossy().into_owned())
        } else {
            None
        }
    }
}

fn media_page_url(song_id: &str) -> Option<String> {
    let t = song_id.trim();
    if t.is_empty() {
        return None;
    }
    if t.starts_with("http://") || t.starts_with("https://") {
        return safe_yt_dlp_media_url(t);
    }
    if let Some(id) = extract_video_id(t) {
        return Some(format!("https://www.youtube.com/watch?v={id}"));
    }
    None
}

pub fn safe_yt_dlp_media_url(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        if !(is_youtube_url(trimmed) || is_x_twitter_url(trimmed) || is_bandcamp_url(trimmed)) {
            return None;
        }
        if !is_public_playback_url(trimmed) {
            return None;
        }
        return Some(trimmed.to_string());
    }
    if let Some(idx) = trimmed.find(':') {
        let scheme = &trimmed[..idx];
        if !scheme.is_empty()
            && scheme.chars().all(|c| c.is_ascii_alphabetic())
            && trimmed[idx..].starts_with("://")
        {
            return None;
        }
    }
    extract_video_id(trimmed)
}

pub fn is_youtube_full_album_title(title: &str) -> bool {
    let t = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c.is_whitespace() || c == '.' || c == '_' || c == '-' {
            c
        } else {
            ' '
        })
        .collect::<String>();
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        return false;
    }
    if t.contains("fullalbum") {
        return true;
    }
    let collapsed = t.replace([' ', '.', '_', '-'], "");
    if collapsed.contains("fullalbum") {
        return true;
    }
    let parts: Vec<&str> = t.split_whitespace().collect();
    for w in parts.windows(2) {
        if w[0] == "full" && w[1] == "album" {
            return true;
        }
    }
    false
}

pub fn is_youtube_livestream_radio_title(title: &str) -> bool {
    let raw = title.trim();
    if raw.is_empty() {
        return false;
    }
    let t = raw.to_ascii_lowercase();
    if regex_contains(raw, r"(?i)\[\s*live\s*\]") {
        return true;
    }
    if t.contains("24/7") || t.contains("24 / 7") {
        return true;
    }
    if t.contains("live stream") || t.contains("livestream") {
        return true;
    }
    if t.contains("nonstop")
        && (t.contains("radio") || t.contains("hits") || t.contains("classic") || t.contains("rock") || t.contains("mix") || t.contains("music"))
    {
        return true;
    }
    if t.contains("beats to") {
        return true;
    }
    if t.contains("radio") && (t.contains("live") || t.contains("24")) {
        return true;
    }
    if looks_like_rolling_clock(raw) {
        return true;
    }
    false
}

fn regex_contains(s: &str, _pat: &str) -> bool {
    let l = s.to_ascii_lowercase();
    l.contains("[live]") || l.contains("[ live ]")
}

fn looks_like_rolling_clock(raw: &str) -> bool {
    // "... 2026-07-12 00:33"
    let b = raw.as_bytes();
    for i in 0..b.len().saturating_sub(16) {
        if b[i].is_ascii_digit()
            && b.get(i + 4) == Some(&b'-')
            && b.get(i + 7) == Some(&b'-')
            && b.get(i + 10) == Some(&b' ')
            && b.get(i + 13) == Some(&b':')
        {
            let y = std::str::from_utf8(&b[i..i + 4]).ok();
            if y.is_some_and(|y| y.starts_with("20")) {
                return true;
            }
        }
    }
    false
}

pub fn is_youtube_too_long(duration_sec: u32) -> bool {
    duration_sec > YOUTUBE_MAX_DURATION_SEC
}

pub fn should_block_youtube_song(
    title: &str,
    duration: u32,
    is_live: bool,
    policy: YoutubePolicy,
) -> bool {
    if policy == YoutubePolicy::Explicit {
        return false;
    }
    if is_youtube_full_album_title(title) {
        return true;
    }
    if is_youtube_livestream_radio_title(title) {
        return true;
    }
    if is_live {
        return true;
    }
    if policy != YoutubePolicy::Radio && is_youtube_too_long(duration) {
        return true;
    }
    false
}

fn parse_entry(json: &str, policy: YoutubePolicy) -> Option<Track> {
    let v: Value = serde_json::from_str(json).ok()?;
    let title = v
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("Unknown")
        .to_string();
    let duration = v.get("duration").and_then(|x| x.as_f64()).unwrap_or(0.0).round() as u32;
    let web = v
        .get("webpage_url")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let extractor = v.get("extractor").and_then(|x| x.as_str()).unwrap_or("");
    let is_yt = extractor.to_ascii_lowercase().contains("youtube")
        || web.contains("youtube.com")
        || web.contains("youtu.be");
    let artist = v
        .get("artist")
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| v.get("album_artist").and_then(|x| x.as_str()).filter(|s| !s.trim().is_empty()))
        .or_else(|| v.get("uploader").and_then(|x| x.as_str()))
        .or_else(|| v.get("channel").and_then(|x| x.as_str()))
        .unwrap_or("")
        .to_string();
    let is_live = v.get("is_live").and_then(|x| x.as_bool()).unwrap_or(false)
        || matches!(
            v.get("live_status").and_then(|x| x.as_str()).map(|s| s.to_ascii_lowercase()),
            Some(s) if s == "is_live" || s == "is_upcoming" || s == "post_live"
        );
    if is_yt && should_block_youtube_song(&title, duration, is_live, policy) {
        return None;
    }
    let label = if is_yt {
        "YouTube"
    } else if web.contains("x.com") || web.contains("twitter.com") {
        "X (Twitter)"
    } else {
        "Web"
    };
    let id = if is_yt {
        v.get("id")
            .and_then(|x| x.as_str())
            .map(str::to_string)
            .or_else(|| extract_video_id(&web))
            .unwrap_or_default()
    } else {
        if web.is_empty() {
            v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string()
        } else {
            web.clone()
        }
    };
    let name = v
        .get("track")
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&title)
        .to_string();
    let album = if is_yt {
        v.get("album")
            .and_then(|x| x.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(label)
            .to_string()
    } else {
        label.to_string()
    };
    Some(Track {
        id,
        title: name,
        artist: if artist.is_empty() {
            label.to_string()
        } else {
            artist
        },
        album,
        platform: Platform::Youtube,
        url: String::new(),
        duration,
        cover_url: v
            .get("thumbnail")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

fn find_yt_dlp() -> Option<PathBuf> {
    for key in ["YT_DLP", "YTDLP"] {
        if let Ok(p) = std::env::var(key) {
            let p = PathBuf::from(p);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let candidates = [
        PathBuf::from("bot/bin/yt-dlp"),
        PathBuf::from("../bot/bin/yt-dlp"),
        PathBuf::from("bin/yt-dlp"),
    ];
    for c in candidates {
        if c.is_file() {
            return Some(c);
        }
    }
    which("yt-dlp")
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn run_yt_dlp(bin: &Path, args: &[String], timeout: Duration) -> Option<String> {
    let run = || {
        use std::io::Read;
        let mut cmd = std::process::Command::new(bin);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().ok()?;
        // Drain stdout on a helper thread so dump-json (~100KB+) cannot fill
        // the pipe and deadlock until the timeout kill.
        let mut stdout_pipe = child.stdout.take()?;
        let reader = std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = stdout_pipe.read_to_string(&mut buf);
            buf
        });
        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(st)) => {
                    let stdout = reader.join().ok()?;
                    if !st.success() {
                        return None;
                    }
                    return Some(stdout);
                }
                Ok(None) => {
                    if start.elapsed() > timeout {
                        let _ = child.kill();
                        let _ = child.wait();
                        let _ = reader.join();
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => {
                    let _ = child.kill();
                    let _ = reader.join();
                    return None;
                }
            }
        }
    };
    match tokio::runtime::Handle::try_current() {
        Ok(_) => tokio::task::block_in_place(run),
        Err(_) => run(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_album_gate() {
        assert!(is_youtube_full_album_title("Artist - Album Name (Full Album)"));
        assert!(is_youtube_full_album_title("FULL ALBUM STREAM"));
        assert!(is_youtube_full_album_title("Something - Full-Album [HQ]"));
        assert!(is_youtube_full_album_title("band fullalbum 2020"));
        assert!(!is_youtube_full_album_title("Full Moon Tonight"));
        assert!(!is_youtube_full_album_title("Bohemian Rhapsody"));
    }

    #[test]
    fn too_long_gate() {
        assert!(!is_youtube_too_long(900));
        assert!(is_youtube_too_long(901));
        assert!(!is_youtube_too_long(0));
        assert!(should_block_youtube_song("Normal Song", 1200, false, YoutubePolicy::Search));
        assert!(!should_block_youtube_song("Normal Song", 240, false, YoutubePolicy::Search));
        assert!(!should_block_youtube_song("Full Album", 60, false, YoutubePolicy::Explicit));
        assert!(should_block_youtube_song("Some Track", 200, true, YoutubePolicy::Search));
    }

    #[test]
    fn livestream_titles() {
        assert!(is_youtube_livestream_radio_title(
            "Classic Rock Radio 24/7 Nonstop Classic Hits 2026-07-12 00:33"
        ));
        assert!(is_youtube_livestream_radio_title(
            "synthwave radio beats to chill/game to 2026-07-12 00:33"
        ));
        assert!(!is_youtube_livestream_radio_title("Bohemian Rhapsody"));
        assert!(!is_youtube_livestream_radio_title("Cool Band - Live at Red Rocks"));
        assert!(!is_youtube_livestream_radio_title("Radio Ga Ga"));
    }

    #[test]
    fn safe_url() {
        assert!(safe_yt_dlp_media_url("ftp://youtube.com/watch?v=abc").is_none());
        assert!(safe_yt_dlp_media_url("file:///etc/passwd").is_none());
        assert!(safe_yt_dlp_media_url("https://example.com/watch?v=abc").is_none());
        assert_eq!(
            safe_yt_dlp_media_url(DEFAULT_DEMO_VIDEO_ID).as_deref(),
            Some(DEFAULT_DEMO_VIDEO_ID)
        );
        assert!(safe_yt_dlp_media_url("https://www.youtube.com/watch?v=hLOheGDwD_0").is_some());
    }

    #[test]
    fn detail_without_binary_is_none() {
        let yt = YoutubeClient { bin: None };
        assert!(yt.detail(DEFAULT_DEMO_VIDEO_ID).is_none());
        assert!(yt.playback_url(DEFAULT_DEMO_VIDEO_ID).is_none());
    }

    #[test]
    fn large_stdout_does_not_deadlock_the_pipe() {
        let dir = std::env::temp_dir().join(format!(
            "mp-ytdlp-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("big-out.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\ndd if=/dev/zero bs=1024 count=200 2>/dev/null | tr '\\0' 'a'\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut p = std::fs::metadata(&script).unwrap().permissions();
            p.set_mode(0o755);
            std::fs::set_permissions(&script, p).unwrap();
        }
        let out = run_yt_dlp(&script, &[], Duration::from_secs(5)).expect("stdout");
        assert!(out.len() >= 200 * 1024, "len={}", out.len());
        let _ = std::fs::remove_dir_all(dir);
    }
}
