// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Directory pool of ready-to-play bumper assets (`docs/radio.md` R-R1).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const AUDIO_EXT: &[&str] = &["mp3", "flac", "wav", "ogg", "m4a", "aac", "opus"];
const RESCAN: Duration = Duration::from_secs(60);

pub struct PrerecordedPool {
    dir: Mutex<PathBuf>,
    files: Mutex<Vec<PathBuf>>,
    scanned_at: Mutex<Option<Instant>>,
}

impl PrerecordedPool {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: Mutex::new(dir.into()),
            files: Mutex::new(Vec::new()),
            scanned_at: Mutex::new(None),
        }
    }

    pub fn set_dir(&self, dir: PathBuf) {
        *self.dir.lock().expect("dir") = dir;
        *self.scanned_at.lock().expect("scan") = None;
    }

    fn ensure_scanned(&self) {
        let mut at = self.scanned_at.lock().expect("scan");
        if let Some(t) = *at {
            if t.elapsed() < RESCAN && !self.files.lock().expect("files").is_empty() {
                return;
            }
        }
        *at = Some(Instant::now());
        let dir = self.dir.lock().expect("dir").clone();
        let mut files = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for ent in rd.flatten() {
                let p = ent.path();
                let ext = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if AUDIO_EXT.iter().any(|x| *x == ext) {
                    files.push(p);
                }
            }
        }
        *self.files.lock().expect("files") = files;
    }

    pub fn pick(&self) -> Option<String> {
        self.ensure_scanned();
        let files = self.files.lock().expect("files");
        if files.is_empty() {
            return None;
        }
        let n = files.len();
        let i = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as usize)
            .unwrap_or(0))
            % n;
        Some(files[i].to_string_lossy().into_owned())
    }
}

pub fn default_bumper_dir(data_dir: &Path) -> PathBuf {
    std::env::var("RADIO_BUMPER_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join("bumpers"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_dir_is_none() {
        let dir = std::env::temp_dir().join(format!(
            "mp-bump-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let pool = PrerecordedPool::new(&dir);
        assert!(pool.pick().is_none());
        std::fs::write(dir.join("id.wav"), b"RIFF").unwrap();
        *pool.scanned_at.lock().unwrap() = None;
        assert!(pool.pick().unwrap().ends_with("id.wav"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
