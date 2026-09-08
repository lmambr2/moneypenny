// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Queue + local library + player. The executor talks to this, not ffmpeg.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::blacklist::PlaybackBlacklist;
use crate::local::{LocalProvider, ResolveHit};
use crate::player::{AudioPlayer, PlayerEvent, PlayerState};
use crate::queue::{replace_queue_with_song, PlayMode, PlayQueue};
use crate::stream::{
    is_spotify_ref, is_streamable_url, is_tidal_url, stream_playback_url, stream_track, StreamBridge,
};
use crate::track::{Platform, QueuedSong, QueueSource, Track};
use crate::youtube::{YoutubeClient, YoutubePolicy};
use crate::ytlibrary::YtLibrary;

pub struct UserPause {
    pub song_id: String,
    pub elapsed: f64,
}

pub struct MusicStation {
    pub queue: Mutex<PlayQueue>,
    pub player: AudioPlayer,
    pub local: LocalProvider,
    pub youtube: YoutubeClient,
    pub blacklist: Option<Arc<PlaybackBlacklist>>,
    pub user_pause: Mutex<Option<UserPause>>,
    pub stream_bridge: StreamBridge,
    yt_library: Mutex<Option<Arc<YtLibrary>>>,
    youtube_save_enabled: AtomicBool,
    connected: Mutex<bool>,
}

impl MusicStation {
    pub fn new(music_dir: impl AsRef<std::path::Path>, blacklist: Option<Arc<PlaybackBlacklist>>) -> Self {
        Self {
            queue: Mutex::new(PlayQueue::new()),
            player: AudioPlayer::new(),
            local: LocalProvider::new(music_dir),
            youtube: YoutubeClient::new(),
            blacklist,
            user_pause: Mutex::new(None),
            stream_bridge: StreamBridge::from_env(),
            yt_library: Mutex::new(None),
            youtube_save_enabled: AtomicBool::new(false),
            connected: Mutex::new(true),
        }
    }

    pub fn attach_yt_library(&self, lib: Arc<YtLibrary>) {
        *self.yt_library.lock().expect("yt lib") = Some(lib);
    }

    pub fn set_youtube_save_enabled(&self, on: bool) {
        self.youtube_save_enabled.store(on, Ordering::SeqCst);
    }

    pub fn youtube_save_enabled(&self) -> bool {
        self.youtube_save_enabled.load(Ordering::SeqCst)
    }

    pub fn set_connected(&self, c: bool) {
        *self.connected.lock().expect("conn") = c;
    }

    pub fn is_connected(&self) -> bool {
        *self.connected.lock().expect("conn")
    }

    pub fn set_dry_run(&self, dry: bool) {
        self.player.set_dry_run(dry);
    }

    pub fn subscribe_player(&self) -> tokio::sync::broadcast::Receiver<PlayerEvent> {
        self.player.subscribe()
    }

    pub fn search_first(&self, query: &str) -> Option<Track> {
        self.search_first_flags(query, &HashSet::new())
    }

    /// `-l` local only, `-y` YouTube, `-s` stream. Else: URL auto-route, then local, then ytsearch.
    pub fn search_first_flags(&self, query: &str, flags: &HashSet<char>) -> Option<Track> {
        let q = query.trim();
        if q.is_empty() {
            return None;
        }
        if flags.contains(&'s') {
            return stream_track(q)
                .or_else(|| self.stream_bridge.resolve_track(q))
                .filter(|t| !self.blocked(t));
        }
        if flags.contains(&'y') {
            return self
                .youtube
                .search(q, 1, if YoutubeClient::can_handle(q) {
                    YoutubePolicy::Explicit
                } else {
                    YoutubePolicy::Search
                })
                .into_iter()
                .find(|t| !self.blocked(t));
        }
        if !flags.contains(&'l') && YoutubeClient::can_handle(q) {
            return self
                .youtube
                .search(q, 1, YoutubePolicy::Explicit)
                .into_iter()
                .find(|t| !self.blocked(t));
        }
        if !flags.contains(&'l') && (is_spotify_ref(q) || is_tidal_url(q)) {
            if let Some(t) = self.stream_bridge.resolve_track(q).filter(|t| !self.blocked(t)) {
                return Some(t);
            }
        }
        if !flags.contains(&'l') && is_streamable_url(q) {
            return stream_track(q).filter(|t| !self.blocked(t));
        }
        if !flags.contains(&'y') {
            if let Some(hit) = self.local.resolve_input(q) {
                match hit {
                    ResolveHit::Song(t) if !self.blocked(&t) => return Some(t),
                    ResolveHit::Playlist { songs, .. } => {
                        if let Some(t) = songs.into_iter().find(|t| !self.blocked(t)) {
                            return Some(t);
                        }
                    }
                    ResolveHit::Song(_) => {}
                }
            }
            for t in self.local.search(q, 16) {
                if !self.blocked(&t) {
                    return Some(t);
                }
            }
        }
        if flags.contains(&'l') {
            return None;
        }
        self.youtube
            .search(q, 1, YoutubePolicy::Search)
            .into_iter()
            .find(|t| !self.blocked(t))
    }

    fn blocked(&self, t: &Track) -> bool {
        self.blacklist.as_ref().is_some_and(|bl| {
            bl.is_blacklisted(Some(&t.id), Some(&t.title), Some(&t.artist))
        })
    }

    /// Vue play-by-id / add-by-id: look up one song on the named platform.
    pub fn song_by_id_platform(&self, song_id: &str, platform: Platform) -> Option<Track> {
        let id = song_id.trim();
        if id.is_empty() {
            return None;
        }
        match platform {
            Platform::Local => self.local.song_by_id(id).filter(|t| !self.blocked(t)),
            Platform::Youtube => self.youtube.detail(id).filter(|t| !self.blocked(t)),
            Platform::Stream => stream_track(id)
                .or_else(|| self.stream_bridge.resolve_track(id))
                .filter(|t| !self.blocked(t)),
        }
    }

    pub fn resolve_and_play(&self, song: &QueuedSong) -> bool {
        self.play_song_at(song, 0.0)
    }

    pub fn play_song_at(&self, song: &QueuedSong, elapsed: f64) -> bool {
        if !self.is_connected() {
            tracing::warn!(id = %song.id, "play_song_at while disconnected");
            return false;
        }
        if self.blacklist.as_ref().is_some_and(|bl| {
            bl.is_blacklisted(Some(&song.id), Some(&song.name), Some(&song.artist))
        }) {
            tracing::info!(id = %song.id, name = %song.name, "blacklist blocked track");
            return false;
        }
        let url = match self.playback_url(song) {
            Some(u) => u,
            None => return false,
        };
        self.player.reset_failures();
        self.player.play(&url, elapsed.max(0.0), song.duration as f64);
        if song.platform == Platform::Youtube && self.youtube_save_enabled() {
            if let Some(lib) = self.yt_library.lock().expect("yt lib").clone() {
                lib.save_in_background(
                    song.id.clone(),
                    song.name.clone(),
                    song.artist.clone(),
                    song.duration,
                );
            }
        }
        true
    }

    fn playback_url(&self, song: &QueuedSong) -> Option<String> {
        match song.platform {
            Platform::Local => {
                if !song.url.is_empty() && !song.url.starts_with("http://") && !song.url.starts_with("https://")
                {
                    return Some(song.url.clone());
                }
                self.local
                    .get_song_url(&song.id)
                    .map(|p| p.to_string_lossy().into_owned())
            }
            Platform::Youtube => {
                let key = if song.id.is_empty() {
                    song.url.as_str()
                } else {
                    song.id.as_str()
                };
                if let Some(lib) = self.yt_library.lock().expect("yt lib").as_ref() {
                    if let Some(p) = lib.lookup(key) {
                        return Some(p);
                    }
                }
                self.youtube.playback_url(key)
            }
            Platform::Stream => {
                if is_spotify_ref(&song.id) || is_tidal_url(&song.id) {
                    return self.stream_bridge.resolve_url(&song.id);
                }
                stream_playback_url(&song.id, &song.url)
            }
        }
    }

    pub fn play_next(&self) -> Option<QueuedSong> {
        let next = {
            let mut q = self.queue.lock().expect("queue");
            q.next()
        };
        match next {
            Some(song) => {
                if self.resolve_and_play(&song) {
                    Some(song)
                } else {
                    self.play_next()
                }
            }
            None => None,
        }
    }

    pub fn replace_with_first_hit(&self, query: &str) -> ReplaceResult {
        self.replace_with_first_hit_flags(query, &HashSet::new())
    }

    /// `!test` / PHASE0 demo: Ella Langley *Choosin' Texas* (`DEFAULT_DEMO_VIDEO_ID`).
    /// Local `[videoId]` copy first, else YouTube. Sequential, play once.
    pub fn play_demo_track(&self) -> ReplaceResult {
        let id = crate::DEFAULT_DEMO_VIDEO_ID;
        if let Some(track) = self.find_demo_local(id) {
            let queued = QueuedSong::from_track(track.clone(), QueueSource::User);
            {
                let mut q = self.queue.lock().expect("queue");
                replace_queue_with_song(&mut q, queued.clone());
            }
            self.player.reset_failures();
            return if self.resolve_and_play(&queued) {
                ReplaceResult::Ok(track)
            } else {
                ReplaceResult::CantPlay(track)
            };
        }
        self.replace_with_first_hit_flags(crate::DEFAULT_DEMO_VIDEO_URL, &HashSet::new())
    }

    fn find_demo_local(&self, video_id: &str) -> Option<Track> {
        let tag = format!("[{video_id}]");
        if let Some(lib) = self.yt_library.lock().expect("yt lib").as_ref() {
            if let Some(path) = lib.lookup(video_id) {
                if let Some(ResolveHit::Song(t)) = self.local.resolve_input(&path) {
                    if !self.blocked(&t) {
                        return Some(t);
                    }
                }
            }
        }
        for t in self.local.search(video_id, 32) {
            if self.blocked(&t) {
                continue;
            }
            let blob = format!("{} {} {}", t.title, t.album, t.id);
            if blob.contains(&tag) || blob.contains(video_id) {
                return Some(t);
            }
        }
        None
    }

    pub fn replace_with_first_hit_flags(&self, query: &str, flags: &HashSet<char>) -> ReplaceResult {
        let Some(track) = self.search_first_flags(query, flags) else {
            return ReplaceResult::NoResults;
        };
        let queued = QueuedSong::from_track(track.clone(), QueueSource::User);
        {
            let mut q = self.queue.lock().expect("queue");
            replace_queue_with_song(&mut q, queued.clone());
        }
        self.player.reset_failures();
        if self.resolve_and_play(&queued) {
            ReplaceResult::Ok(track)
        } else {
            ReplaceResult::CantPlay(track)
        }
    }

    pub fn clear_user_pause(&self) {
        *self.user_pause.lock().expect("pause") = None;
    }

    pub fn pause_playback(&self) -> String {
        let state = self.player.get_state();
        let current = self.queue.lock().expect("queue").current();
        if (state == PlayerState::Playing || state == PlayerState::Paused) && current.is_some() {
            let elapsed = self.player.get_elapsed().max(0.0).floor();
            *self.user_pause.lock().expect("pause") = Some(UserPause {
                song_id: current.as_ref().unwrap().id.clone(),
                elapsed,
            });
            self.player.stop();
            return "Paused".into();
        }
        if self.user_pause.lock().expect("pause").is_some() {
            return "Already paused".into();
        }
        if let Some(cur) = current {
            *self.user_pause.lock().expect("pause") = Some(UserPause {
                song_id: cur.id,
                elapsed: 0.0,
            });
            return "Paused".into();
        }
        "Nothing is playing".into()
    }

    pub fn resume_playback(&self) -> String {
        let state = self.player.get_state();
        if state == PlayerState::Playing && self.user_pause.lock().expect("pause").is_none() {
            return "Already playing".into();
        }
        if state == PlayerState::Paused {
            self.player.resume();
            *self.user_pause.lock().expect("pause") = None;
            return "Resumed".into();
        }
        let current = self.queue.lock().expect("queue").current();
        let checkpoint = self.user_pause.lock().expect("pause");
        if let (Some(cur), Some(cp)) = (current.as_ref(), checkpoint.as_ref()) {
            if cur.id == cp.song_id {
                let elapsed = cp.elapsed;
                drop(checkpoint);
                if !self.play_song_at(&cur, elapsed) {
                    return "Could not resume — try play again".into();
                }
                *self.user_pause.lock().expect("pause") = None;
                return "Resumed".into();
            }
        }
        "Nothing to resume".into()
    }
}

#[derive(Debug)]
pub enum ReplaceResult {
    Ok(Track),
    NoResults,
    CantPlay(Track),
}

#[allow(dead_code)]
pub fn _mode_touch() -> PlayMode {
    PlayMode::Sequential
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn tmp_station() -> (std::path::PathBuf, MusicStation) {
        let dir = std::env::temp_dir().join(format!(
            "mp-st-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("titanium.mp3"), b"fake").unwrap();
        let st = MusicStation::new(&dir, None);
        st.set_dry_run(true);
        (dir, st)
    }

    #[test]
    fn flags_route_local_youtube_stream() {
        let (dir, st) = tmp_station();
        let stream = "https://example.com/radio.mp3";
        let mut s = HashSet::new();
        s.insert('s');
        let hit = st.search_first_flags(stream, &s).unwrap();
        assert_eq!(hit.platform, Platform::Stream);
        assert_eq!(hit.id, stream);

        let mut l = HashSet::new();
        l.insert('l');
        assert!(st.search_first_flags(stream, &l).is_none());
        assert!(st.search_first_flags("titanium", &l).is_some());

        let mut y = HashSet::new();
        y.insert('y');
        // No yt-dlp in unit tests — -y must not fall through to local.
        assert!(st.search_first_flags("titanium", &y).is_none());

        let auto = st.search_first_flags(stream, &HashSet::new()).unwrap();
        assert_eq!(auto.platform, Platform::Stream);

        let local = st.search_first_flags("titanium", &HashSet::new()).unwrap();
        assert_eq!(local.platform, Platform::Local);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn song_by_id_stream_and_local() {
        let (dir, st) = tmp_station();
        let local = st.search_first("titanium").unwrap();
        assert!(st.song_by_id_platform(&local.id, Platform::Local).is_some());
        assert!(st
            .song_by_id_platform("https://example.com/a.mp3", Platform::Stream)
            .is_some());
        assert!(st
            .song_by_id_platform("http://127.0.0.1/a.mp3", Platform::Stream)
            .is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
