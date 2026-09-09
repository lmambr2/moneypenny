// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Local library. `safe_resolve` is the security boundary: realpath must stay
//! under MUSIC_DIR (F-1/F-3). Public ids are SHA-1 of the real path (F-2).

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use sha1::{Digest, Sha1};

use crate::track::{Platform, Track};
use crate::{MusicError, MusicProvider};

#[derive(Debug)]
pub enum DeleteSongError {
    NotFound,
    Forbidden,
    Io(String),
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

const MAX_WALK_DEPTH: u32 = 64;
const DEFAULT_EXTS: &[&str] = &[".mp3", ".flac", ".wav", ".ogg", ".m4a", ".aac", ".wma", ".opus"];

#[derive(Debug, Clone)]
struct IndexedSong {
    track: Track,
    absolute_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub song_count: usize,
}

#[derive(Debug, Clone)]
pub enum ResolveHit {
    Song(Track),
    Playlist { playlist: Playlist, songs: Vec<Track> },
}

pub struct LocalProvider {
    music_dir: PathBuf,
    songs: Mutex<Vec<IndexedSong>>,
    id_to_path: Mutex<HashMap<String, PathBuf>>,
    playlist_id_to_path: Mutex<HashMap<String, PathBuf>>,
    m3u_playlists: Mutex<HashMap<PathBuf, Playlist>>,
    m3u_songs: Mutex<HashMap<PathBuf, Vec<Track>>>,
    indexed: Mutex<bool>,
    extensions: Vec<String>,
}

impl LocalProvider {
    pub fn new(music_dir: impl AsRef<Path>) -> Self {
        let music_dir = music_dir.as_ref().canonicalize().unwrap_or_else(|_| {
            std::path::absolute(music_dir.as_ref()).unwrap_or_else(|_| music_dir.as_ref().to_path_buf())
        });
        Self {
            music_dir,
            songs: Mutex::new(Vec::new()),
            id_to_path: Mutex::new(HashMap::new()),
            playlist_id_to_path: Mutex::new(HashMap::new()),
            m3u_playlists: Mutex::new(HashMap::new()),
            m3u_songs: Mutex::new(HashMap::new()),
            indexed: Mutex::new(false),
            extensions: DEFAULT_EXTS.iter().map(|s| s.to_string()).collect(),
        }
    }

    pub fn music_dir(&self) -> &Path {
        &self.music_dir
    }

    fn opaque_id(real_path: &Path) -> String {
        let mut h = Sha1::new();
        h.update(real_path.to_string_lossy().as_bytes());
        hex::encode(h.finalize())
    }

    fn supported(&self, ext: &str) -> bool {
        self.extensions.iter().any(|e| e.eq_ignore_ascii_case(ext))
    }

    fn ensure_indexed(&self) {
        if *self.indexed.lock().expect("index") {
            return;
        }
        self.scan();
        *self.indexed.lock().expect("index") = true;
    }

    fn scan(&self) {
        self.songs.lock().expect("songs").clear();
        self.id_to_path.lock().expect("id").clear();
        self.playlist_id_to_path.lock().expect("pl").clear();
        self.m3u_playlists.lock().expect("m3u").clear();
        self.m3u_songs.lock().expect("m3u songs").clear();
        let _ = self.walk(&self.music_dir, 0);
        tracing::info!(
            tracks = self.songs.lock().expect("songs").len(),
            dir = %self.music_dir.display(),
            "LocalProvider indexed"
        );
    }

    fn walk(&self, dir: &Path, depth: u32) -> std::io::Result<()> {
        if depth > MAX_WALK_DEPTH {
            tracing::warn!(dir = %dir.display(), "max directory depth reached");
            return Ok(());
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return Ok(()),
        };
        for entry in entries.flatten() {
            let full = entry.path();
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_symlink() {
                if std::fs::metadata(&full).map(|m| m.is_file()).unwrap_or(false) {
                    self.index_by_extension(&full);
                }
                continue;
            }
            if ft.is_dir() {
                let _ = self.walk(&full, depth + 1);
            } else if ft.is_file() {
                self.index_by_extension(&full);
            }
        }
        Ok(())
    }

    fn index_by_extension(&self, full: &Path) {
        let ext = full
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy().to_ascii_lowercase()))
            .unwrap_or_default();
        if self.supported(&ext) {
            self.index_file(full);
        } else if ext == ".m3u" || ext == ".m3u8" {
            self.index_m3u(full);
        }
    }

    fn contained(real: &Path, base: &Path) -> bool {
        if real == base {
            return true;
        }
        let sep = std::path::MAIN_SEPARATOR;
        let rs = real.to_string_lossy();
        let bs = base.to_string_lossy();
        rs.starts_with(&format!("{bs}{sep}"))
    }

    fn index_file(&self, absolute: &Path) {
        let Ok(real) = std::fs::canonicalize(absolute) else {
            return;
        };
        let Ok(real_base) = std::fs::canonicalize(&self.music_dir) else {
            return;
        };
        if !Self::contained(&real, &real_base) && real != real_base {
            tracing::warn!(path = %real.display(), "skipping file outside music dir");
            return;
        }
        let id = Self::opaque_id(&real);
        self.id_to_path
            .lock()
            .expect("id")
            .insert(id.clone(), real.clone());
        let name = real
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Unknown".into());
        let album = real
            .parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Unknown Album".into());
        let track = Track {
            id,
            title: name,
            artist: "Unknown Artist".into(),
            album,
            platform: Platform::Local,
            url: real.to_string_lossy().into_owned(),
            duration: 0,
            cover_url: String::new(),
        };
        self.songs.lock().expect("songs").push(IndexedSong {
            track,
            absolute_path: real,
        });
    }

    fn index_m3u(&self, absolute: &Path) {
        let Ok(real) = std::fs::canonicalize(absolute) else {
            return;
        };
        let Ok(real_base) = std::fs::canonicalize(&self.music_dir) else {
            return;
        };
        if !Self::contained(&real, &real_base) && real != real_base {
            return;
        }
        let Ok(content) = std::fs::read_to_string(&real) else {
            return;
        };
        let base_dir = real.parent().unwrap_or(&real);
        let songs = self.parse_m3u(&content, base_dir);
        if songs.is_empty() {
            return;
        }
        let name = real
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "playlist".into());
        let id = Self::opaque_id(&real);
        self.playlist_id_to_path
            .lock()
            .expect("pl")
            .insert(id.clone(), real.clone());
        let playlist = Playlist {
            id,
            name,
            song_count: songs.len(),
        };
        self.m3u_playlists
            .lock()
            .expect("m3u")
            .insert(real.clone(), playlist);
        self.m3u_songs.lock().expect("m3u songs").insert(real, songs);
    }

    fn parse_m3u(&self, content: &str, base_dir: &Path) -> Vec<Track> {
        let mut songs = Vec::new();
        let mut current_name = String::new();
        let mut current_artist = String::new();
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with("#EXTM3U") {
                continue;
            }
            if let Some(info) = trimmed.strip_prefix("#EXTINF:") {
                let after = info.split_once(',').map(|(_, r)| r).unwrap_or(info);
                if let Some((a, n)) = after.split_once(" - ") {
                    current_artist = a.trim().to_string();
                    current_name = n.trim().to_string();
                } else {
                    current_name = after.trim().to_string();
                    current_artist = "Unknown".into();
                }
                continue;
            }
            if trimmed.starts_with('#') {
                continue;
            }
            let file_path = if Path::new(trimmed).is_absolute() {
                PathBuf::from(trimmed)
            } else {
                base_dir.join(trimmed)
            };
            let file_path = lexical_normalize(&file_path);
            // F-3 lexical containment — no out-of-tree m3u entries.
            if file_path != self.music_dir && !Self::contained(&file_path, &self.music_dir) {
                current_name.clear();
                current_artist.clear();
                continue;
            }
            let id = Self::opaque_id(&file_path);
            self.id_to_path
                .lock()
                .expect("id")
                .insert(id.clone(), file_path.clone());
            let name = if current_name.is_empty() {
                file_path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| trimmed.to_string())
            } else {
                current_name.clone()
            };
            songs.push(Track {
                id,
                title: name,
                artist: current_artist.clone(),
                album: "Playlist".into(),
                platform: Platform::Local,
                url: String::new(),
                duration: 0,
                cover_url: String::new(),
            });
            current_name.clear();
            current_artist.clear();
        }
        songs
    }

    /// Authoritative path guard. Returns the canonical path or None.
    pub fn safe_resolve(&self, requested: &str) -> Option<PathBuf> {
        let candidate = if Path::new(requested).is_absolute() {
            PathBuf::from(requested)
        } else {
            self.music_dir.join(requested)
        };
        let real = std::fs::canonicalize(&candidate).ok()?;
        let real_base = std::fs::canonicalize(&self.music_dir).ok()?;
        if real == real_base || Self::contained(&real, &real_base) {
            Some(real)
        } else {
            let safe: String = requested
                .chars()
                .map(|c| if c.is_control() { '?' } else { c })
                .take(200)
                .collect();
            tracing::warn!(requested = %safe, "path traversal blocked");
            None
        }
    }

    pub fn get_song_url(&self, song_id: &str) -> Option<PathBuf> {
        let candidate = self
            .id_to_path
            .lock()
            .expect("id")
            .get(song_id)
            .cloned()
            .unwrap_or_else(|| PathBuf::from(song_id));
        self.safe_resolve(&candidate.to_string_lossy())
    }

    pub fn search(&self, query: &str, limit: usize) -> Vec<Track> {
        self.ensure_indexed();
        let q = query.to_lowercase();
        let songs = self.songs.lock().expect("songs");
        let matches: Vec<Track> = if q.trim().is_empty() {
            songs.iter().map(|s| s.track.clone()).collect()
        } else {
            songs
                .iter()
                .filter(|s| {
                    s.track.title.to_lowercase().contains(&q)
                        || s.track.artist.to_lowercase().contains(&q)
                        || s.track.album.to_lowercase().contains(&q)
                })
                .map(|s| s.track.clone())
                .collect()
        };
        matches.into_iter().take(limit).collect()
    }

    pub fn resolve_input(&self, input: &str) -> Option<ResolveHit> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return None;
        }
        self.ensure_indexed();
        if let Some(safe) = self.safe_resolve(trimmed) {
            {
                let songs = self.songs.lock().expect("songs");
                if let Some(found) = songs.iter().find(|s| s.absolute_path == safe) {
                    return Some(ResolveHit::Song(found.track.clone()));
                }
            }
            if let Some(pl) = self.m3u_playlists.lock().expect("m3u").get(&safe).cloned() {
                let songs = self
                    .m3u_songs
                    .lock()
                    .expect("m3u songs")
                    .get(&safe)
                    .cloned()
                    .unwrap_or_default();
                return Some(ResolveHit::Playlist {
                    playlist: pl,
                    songs,
                });
            }
            let ext = safe
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy().to_ascii_lowercase()))
                .unwrap_or_default();
            if self.supported(&ext) {
                let name = safe
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "Unknown".into());
                let id = Self::opaque_id(&safe);
                self.id_to_path
                    .lock()
                    .expect("id")
                    .insert(id.clone(), safe.clone());
                return Some(ResolveHit::Song(Track {
                    id,
                    title: name,
                    artist: "Unknown".into(),
                    album: "Unknown".into(),
                    platform: Platform::Local,
                    url: safe.to_string_lossy().into_owned(),
                    duration: 0,
                    cover_url: String::new(),
                }));
            }
            return None;
        }
        let lower = trimmed.to_lowercase();
        let songs = self.songs.lock().expect("songs");
        songs
            .iter()
            .find(|s| {
                s.absolute_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_lowercase().contains(&lower))
                    .unwrap_or(false)
            })
            .map(|s| ResolveHit::Song(s.track.clone()))
    }

    pub fn get_playlist_songs(&self, playlist_id: &str) -> Vec<Track> {
        self.ensure_indexed();
        let real = self
            .playlist_id_to_path
            .lock()
            .expect("pl")
            .get(playlist_id)
            .cloned()
            .unwrap_or_else(|| PathBuf::from(playlist_id));
        self.m3u_songs
            .lock()
            .expect("m3u songs")
            .get(&real)
            .cloned()
            .unwrap_or_default()
    }

    pub fn refresh(&self) -> usize {
        *self.indexed.lock().expect("index") = false;
        self.ensure_indexed();
        self.songs.lock().expect("songs").len()
    }

    pub fn track_count(&self) -> usize {
        self.ensure_indexed();
        self.songs.lock().expect("songs").len()
    }

    pub fn song_by_id(&self, id: &str) -> Option<Track> {
        self.ensure_indexed();
        self.songs
            .lock()
            .expect("songs")
            .iter()
            .find(|s| s.track.id == id)
            .map(|s| s.track.clone())
    }

    pub fn path_for_id(&self, id: &str) -> Option<PathBuf> {
        self.ensure_indexed();
        self.id_to_path.lock().ok()?.get(id).cloned()
    }

    /// Delete a track from disk by opaque public id (admin web UI).
    /// Realpath must stay under MUSIC_DIR; re-index after unlink.
    pub fn delete_song(&self, song_id: &str) -> Result<String, DeleteSongError> {
        if song_id.is_empty()
            || song_id.contains("..")
            || song_id.contains('/')
            || song_id.contains('\\')
        {
            return Err(DeleteSongError::NotFound);
        }
        self.ensure_indexed();
        let abs = self
            .id_to_path
            .lock()
            .expect("id")
            .get(song_id)
            .cloned()
            .ok_or(DeleteSongError::NotFound)?;
        let real = std::fs::canonicalize(&abs).map_err(|_| DeleteSongError::NotFound)?;
        let real_base =
            std::fs::canonicalize(&self.music_dir).map_err(|_| DeleteSongError::NotFound)?;
        if real == real_base {
            return Err(DeleteSongError::Forbidden);
        }
        if !Self::contained(&real, &real_base) {
            tracing::warn!(id = %song_id, "deleteSong blocked outside music dir");
            return Err(DeleteSongError::Forbidden);
        }
        let name = self
            .song_by_id(song_id)
            .map(|t| t.title)
            .unwrap_or_else(|| {
                real.file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| song_id.to_string())
            });
        match std::fs::remove_file(&real) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(DeleteSongError::Io(e.to_string())),
        }
        self.refresh();
        Ok(name)
    }

    /// Write into `musicDir/uploads/` and re-index. Same rules as Node `uploadSong`.
    pub fn upload_song(&self, original_filename: &str, data: &[u8]) -> Result<Track, MusicError> {
        let mut base = std::path::Path::new(original_filename)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("upload.bin")
            .to_string();
        base = base
            .replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "-")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if base.len() > 200 {
            base.truncate(200);
        }
        if base.is_empty() {
            base = "upload.mp3".into();
        }
        let ext = std::path::Path::new(&base)
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| format!(".{}", s.to_ascii_lowercase()))
            .unwrap_or_default();
        if !self.extensions.iter().any(|e| e == &ext) {
            return Err(MusicError::Message(format!(
                "Unsupported audio format. Allowed: {}",
                self.extensions.join(", ")
            )));
        }
        let uploads = self.music_dir.join("uploads");
        std::fs::create_dir_all(&uploads).map_err(|e| MusicError::Message(e.to_string()))?;
        let name_no_ext = std::path::Path::new(&base)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("upload");
        let mut target = uploads.join(&base);
        let mut counter = 0u32;
        while target.exists() {
            counter += 1;
            if counter > 9999 {
                return Err(MusicError::Message("Too many name collisions".into()));
            }
            target = uploads.join(format!("{name_no_ext} ({counter}){ext}"));
        }
        let tmp = PathBuf::from(format!("{}.uploading", target.display()));
        if let Err(e) = std::fs::write(&tmp, data) {
            let _ = std::fs::remove_file(&tmp);
            return Err(MusicError::Message(e.to_string()));
        }
        if let Err(e) = std::fs::rename(&tmp, &target) {
            let _ = std::fs::remove_file(&tmp);
            return Err(MusicError::Message(e.to_string()));
        }
        self.refresh();
        let real = target.canonicalize().unwrap_or(target.clone());
        let id = Self::opaque_id(&real);
        if let Some(song) = self.song_by_id(&id) {
            return Ok(song);
        }
        Ok(Track {
            id,
            title: name_no_ext.to_string(),
            artist: "Unknown Artist".into(),
            album: "Unknown Album".into(),
            platform: Platform::Local,
            url: real.to_string_lossy().into_owned(),
            duration: 0,
            cover_url: String::new(),
        })
    }
}

impl MusicProvider for LocalProvider {
    async fn resolve(&self, input: &str) -> Result<Track, MusicError> {
        match self.resolve_input(input) {
            Some(ResolveHit::Song(t)) => Ok(t),
            Some(ResolveHit::Playlist { songs, .. }) => songs
                .into_iter()
                .next()
                .ok_or_else(|| MusicError::Message("empty playlist".into())),
            None => Err(MusicError::Message("not found".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_lib() -> (PathBuf, LocalProvider) {
        let dir = std::env::temp_dir().join(format!(
            "mp-local-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("music/rock")).unwrap();
        std::fs::create_dir_all(dir.join("music/pop")).unwrap();
        std::fs::write(dir.join("music/rock/test1.mp3"), b"fake-mp3").unwrap();
        std::fs::write(dir.join("music/pop/test2.flac"), b"fake-flac").unwrap();
        let p = LocalProvider::new(&dir);
        (dir, p)
    }

    #[test]
    fn blocks_traversal() {
        let (dir, p) = tmp_lib();
        assert!(p.resolve_input("../../../etc/passwd").is_none());
        assert!(p.resolve_input("/etc/passwd").is_none());
        assert!(p.get_song_url("../../../etc/shadow").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn allows_in_dir_relative() {
        let (dir, p) = tmp_lib();
        let hit = p.resolve_input("music/rock/test1.mp3");
        match hit {
            Some(ResolveHit::Song(t)) => {
                assert!(t.title.contains("test1"));
                assert_eq!(t.platform, Platform::Local);
                assert!(!t.id.contains('/'));
            }
            other => panic!("expected song, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn filename_match() {
        let (dir, p) = tmp_lib();
        let hit = p.resolve_input("test1");
        assert!(matches!(hit, Some(ResolveHit::Song(_))));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn delete_song_removes_file_and_index() {
        let (dir, p) = tmp_lib();
        let hit = p.resolve_input("music/rock/test1.mp3");
        let Some(ResolveHit::Song(t)) = hit else {
            panic!("expected song");
        };
        let name = p.delete_song(&t.id).unwrap();
        assert!(name.contains("test1"));
        assert!(p.song_by_id(&t.id).is_none());
        assert!(!dir.join("music/rock/test1.mp3").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn delete_song_unknown_id() {
        let (dir, p) = tmp_lib();
        assert!(matches!(
            p.delete_song("not-a-real-id"),
            Err(DeleteSongError::NotFound)
        ));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_non_audio() {
        let (dir, p) = tmp_lib();
        std::fs::write(dir.join("music/notes.txt"), b"not audio").unwrap();
        assert!(p.resolve_input("music/notes.txt").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn m3u_drops_out_of_tree() {
        let (dir, p) = tmp_lib();
        let m3u = [
            "#EXTM3U",
            "#EXTINF:0,In Tree",
            "rock/test1.mp3",
            "#EXTINF:0,Escape",
            "../../../../etc/passwd",
            "/etc/shadow",
        ]
        .join("\n");
        std::fs::write(dir.join("music/list.m3u"), m3u).unwrap();
        let pl = p.resolve_input("music/list.m3u");
        match pl {
            Some(ResolveHit::Playlist { playlist, songs }) => {
                assert_eq!(songs.len(), 1);
                assert_eq!(songs[0].title, "In Tree");
                assert!(!songs[0].id.contains('/'));
                assert!(!songs[0].id.contains("passwd"));
                let via = p.get_playlist_songs(&playlist.id);
                assert_eq!(via.len(), 1);
            }
            other => panic!("expected playlist, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(dir);
    }
}
