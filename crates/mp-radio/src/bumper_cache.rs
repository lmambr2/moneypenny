// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! File cache for unclassified TTS bumpers. Key is voice + text, so a voice
//! change misses. Higher floors are refused: a cached wav can be replayed
//! to anyone in the channel.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sha2::{Digest, Sha256};

pub struct BumperCache {
    dir: Mutex<PathBuf>,
}

impl BumperCache {
    pub fn new() -> Self {
        Self::with_dir(std::env::temp_dir().join("moneypenny-bumper-cache"))
    }

    pub fn with_dir(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Self {
            dir: Mutex::new(dir),
        }
    }

    pub fn set_dir(&self, dir: PathBuf) {
        let _ = std::fs::create_dir_all(&dir);
        *self.dir.lock().expect("bumper cache") = dir;
    }

    pub fn get(&self, voice: &str, text: &str) -> Option<PathBuf> {
        let dir = self.dir.lock().expect("bumper cache").clone();
        let hash = cache_key(voice, text);
        find_file(&dir, &hash).filter(|p| p.is_file())
    }

    /// `None` when `floor` is not `unclassified` or the write fails.
    pub fn put(
        &self,
        voice: &str,
        text: &str,
        audio: &[u8],
        ext: &str,
        floor: &str,
    ) -> Option<PathBuf> {
        if floor != "unclassified" || audio.is_empty() || text.trim().is_empty() {
            return None;
        }
        let dir = self.dir.lock().expect("bumper cache").clone();
        let _ = std::fs::create_dir_all(&dir);
        let hash = cache_key(voice, text);
        remove_hash_files(&dir, &hash);
        let path = dir.join(format!("{hash}.{}", clean_ext(ext)));
        if std::fs::write(&path, audio).is_err() {
            return None;
        }
        Some(path)
    }

    pub fn clear(&self) -> usize {
        let dir = self.dir.lock().expect("bumper cache").clone();
        let Ok(rd) = std::fs::read_dir(&dir) else {
            return 0;
        };
        let mut n = 0usize;
        for ent in rd.flatten() {
            let path = ent.path();
            if path.is_file() && std::fs::remove_file(&path).is_ok() {
                n += 1;
            }
        }
        n
    }
}

impl Default for BumperCache {
    fn default() -> Self {
        Self::new()
    }
}

fn cache_key(voice: &str, text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(voice.as_bytes());
    hasher.update(b"\n");
    hasher.update(text.trim().as_bytes());
    hex::encode(hasher.finalize())
}

fn clean_ext(ext: &str) -> String {
    let e: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    if e.is_empty() { "wav".into() } else { e }
}

fn find_file(dir: &Path, hash: &str) -> Option<PathBuf> {
    let rd = std::fs::read_dir(dir).ok()?;
    for ent in rd.flatten() {
        let name = ent.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(hash) && ent.path().is_file() {
            return Some(ent.path());
        }
    }
    None
}

fn remove_hash_files(dir: &Path, hash: &str) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        if name.starts_with(hash) && ent.path().is_file() {
            let _ = std::fs::remove_file(ent.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_get_clear_and_refuse_other_floors() {
        let dir = std::env::temp_dir().join(format!(
            "mp-bumper-cache-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache = BumperCache::with_dir(dir.clone());
        assert!(
            cache
                .put("en_GB-cori-high", "hello", b"RIFF", "wav", "secret")
                .is_none()
        );
        assert!(cache.get("en_GB-cori-high", "hello").is_none());
        let path = cache
            .put("en_GB-cori-high", "hello", b"RIFF", "wav", "unclassified")
            .unwrap();
        assert!(path.is_file());
        let hit = cache.get("en_GB-cori-high", "  hello  ").unwrap();
        assert_eq!(hit, path);
        assert!(cache.get("other-voice", "hello").is_none());
        assert_eq!(cache.clear(), 1);
        assert!(cache.get("en_GB-cori-high", "hello").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
