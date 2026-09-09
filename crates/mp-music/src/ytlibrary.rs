// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! YouTube → local library MP3. Failed saves never affect the playing stream.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use mp_db::Database;

use crate::blacklist::extract_video_id;
use crate::youtube::YoutubeClient;

pub const SAVE_SUBDIR: &str = "youtube";

pub struct YtLibrary {
    db: Arc<Database>,
    music_dir: PathBuf,
    youtube: YoutubeClient,
    in_flight: Arc<Mutex<std::collections::HashSet<String>>>,
}

impl YtLibrary {
    pub fn new(db: Arc<Database>, music_dir: impl AsRef<Path>, youtube: YoutubeClient) -> Self {
        Self {
            db,
            music_dir: music_dir.as_ref().to_path_buf(),
            youtube,
            in_flight: Arc::new(Mutex::new(std::collections::HashSet::new())),
        }
    }

    pub fn lookup(&self, video_id: &str) -> Option<String> {
        let video_id = extract_video_id(video_id)?;
        if let Ok(Some(p)) = self.db.yt_saved().lookup(&video_id) {
            if Path::new(&p).is_file() {
                return Some(p);
            }
        }
        find_saved_on_disk(&self.music_dir, &video_id)
    }

    pub fn save_in_background(&self, video_id: String, title: String, artist: String, duration: u32) {
        let Some(video_id) = extract_video_id(&video_id) else {
            // X/Bandcamp page URLs are not safe -o template stems.
            return;
        };
        if self.lookup(&video_id).is_some() {
            return;
        }
        {
            let mut g = self.in_flight.lock().expect("yt inflight");
            if !g.insert(video_id.clone()) {
                return;
            }
        }
        let db = Arc::clone(&self.db);
        let music_dir = self.music_dir.clone();
        let youtube = self.youtube.clone();
        let inflight = Arc::clone(&self.in_flight);
        let vid = video_id.clone();
        std::thread::spawn(move || {
            let out_dir = music_dir.join(SAVE_SUBDIR);
            let base = sanitize_base(&artist, &title, &vid);
            match youtube.download_audio_mp3(&vid, &out_dir, &base) {
                Some(path) => {
                    if let Err(e) = db.yt_saved().insert(&vid, &path, &title, &artist, duration as i64)
                    {
                        tracing::warn!(error = %e, video_id = %vid, "YT save: db insert failed");
                    } else {
                        tracing::info!(video_id = %vid, path = %path, "YT save: saved to library");
                    }
                }
                None => tracing::warn!(video_id = %vid, "YT save failed (kept streaming)"),
            }
            inflight.lock().expect("yt inflight").remove(&vid);
        });
    }
}

pub fn find_saved_on_disk(music_dir: &Path, video_id: &str) -> Option<String> {
    let video_id = extract_video_id(video_id)?;
    let dir = music_dir.join(SAVE_SUBDIR);
    let tag = format!("[{video_id}]");
    let rd = std::fs::read_dir(&dir).ok()?;
    for ent in rd.flatten() {
        let name = ent.file_name();
        let name = name.to_string_lossy();
        if !name.to_ascii_lowercase().ends_with(".mp3") {
            continue;
        }
        if name.contains(&tag) {
            let full = ent.path();
            if full.is_file() {
                return Some(full.to_string_lossy().into_owned());
            }
        }
    }
    None
}

pub fn sanitize_base(artist: &str, title: &str, video_id: &str) -> String {
    let raw = [artist, title]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" - ");
    let raw = if raw.is_empty() { video_id } else { &raw };
    let safe: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | '?' | '%' | '*' | ':' | '|' | '"' | '<' | '>' => ' ',
            other => other,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let safe = if safe.len() > 150 {
        safe.chars().take(150).collect()
    } else {
        safe
    };
    let id = extract_video_id(video_id).unwrap_or_else(|| {
        video_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .take(11)
            .collect()
    });
    if id.is_empty() {
        return safe;
    }
    format!("{} [{id}]", if safe.is_empty() { id.as_str() } else { &safe })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_filename() {
        let b = sanitize_base("A/B", "Hi?", "hLOheGDwD_0");
        assert!(b.contains("[hLOheGDwD_0]"));
        assert!(!b.contains('/'));
        assert!(!b.contains('?'));
    }

    #[test]
    fn save_id_rejects_path_injection() {
        assert!(extract_video_id("https://x.com/../../../../tmp/pwn").is_none());
        assert!(extract_video_id("https://x.com/%(id)s").is_none());
        let b = sanitize_base("a", "b", "https://x.com/../../tmp/x");
        assert!(!b.contains(".."));
        assert!(!b.contains('/'));
        assert!(!b.contains('%'));
    }
}
