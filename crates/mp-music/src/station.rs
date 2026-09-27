// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Queue + local library + player. The executor talks to this, not ffmpeg.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::blacklist::PlaybackBlacklist;
use crate::local::{LocalProvider, ResolveHit};
use crate::player::{AudioPlayer, PlayerEvent, PlayerState};
use crate::queue::{PlayMode, PlayQueue, replace_queue_with_song, replace_queue_with_tracks};
use crate::stream::{
    StreamBridge, is_spotify_ref, is_streamable_url, is_tidal_url, stream_playback_url,
    stream_track,
};
use crate::track::{Platform, QueueSource, QueuedSong, Track};
use crate::youtube::{
    SG1_THEME_URL, SG1_THEME_VIDEO_ID, YoutubeClient, YoutubePolicy, is_demo_test_track,
};
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
    prefetch: Arc<Mutex<Option<(String, String)>>>,
    votes: Mutex<VoteState>,
}

struct VoteState {
    song_id: String,
    uids: HashSet<String>,
}

/// Who can be counted for a `!vote` majority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoteAudience {
    /// Dashboard, MCP, or any caller that is not a TeamSpeak user.
    NotOnTeamspeak,
    /// clientlist failed or the bot's channel id is unknown.
    Uncounted,
    /// Listeners in the bot's channel, excluding the bot.
    Listeners(u32),
}

pub fn vote_needed(listeners_excluding_bot: u32) -> u32 {
    ((listeners_excluding_bot + 1) / 2).max(1)
}

impl MusicStation {
    pub fn new(
        music_dir: impl AsRef<std::path::Path>,
        blacklist: Option<Arc<PlaybackBlacklist>>,
    ) -> Self {
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
            prefetch: Arc::new(Mutex::new(None)),
            votes: Mutex::new(VoteState {
                song_id: String::new(),
                uids: HashSet::new(),
            }),
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

    fn current_song_id(&self) -> String {
        self.queue
            .lock()
            .expect("queue")
            .current()
            .map(|s| s.id)
            .unwrap_or_default()
    }

    pub fn is_demo_playing(&self) -> bool {
        let q = self.queue.lock().expect("queue");
        q.current()
            .is_some_and(|s| is_demo_test_track(&s.id, &s.name, &s.album))
    }

    fn record_vote(&self, uid: &str) -> usize {
        let song_id = self.current_song_id();
        let mut g = self.votes.lock().expect("votes");
        if g.song_id != song_id {
            g.uids.clear();
            g.song_id = song_id;
        }
        g.uids.insert(uid.to_string());
        g.uids.len()
    }

    fn clear_votes(&self) {
        self.votes.lock().expect("votes").uids.clear();
    }

    /// Majority skip. The demo track is not votable. A failed headcount still
    /// records the uid so the next successful count includes it.
    pub async fn cast_vote(&self, uid: &str, audience: VoteAudience) -> String {
        if self.is_demo_playing() {
            return "The !test demo track can only be skipped by Chairman or server admin (not by vote).".into();
        }
        match audience {
            VoteAudience::NotOnTeamspeak => "Vote can only be used in TeamSpeak".into(),
            VoteAudience::Uncounted => {
                self.record_vote(uid);
                "Can't count listeners right now (TeamSpeak timed out). Try the vote again in a moment.".into()
            }
            VoteAudience::Listeners(n) => {
                let votes = self.record_vote(uid);
                let needed = vote_needed(n) as usize;
                if votes >= needed {
                    self.clear_votes();
                    let _ = self.play_next_async().await;
                    format!("Vote passed ({votes}/{needed}). Skipping to next song.")
                } else {
                    format!(
                        "Vote to skip: {votes}/{needed} (need {} more)",
                        needed - votes
                    )
                }
            }
        }
    }

    /// `!chevron7` — local `[aafGXNWHGaw]` first, then YouTube.
    pub async fn play_chevron7(&self) -> String {
        if let Some(track) = self.find_local_by_video_id(SG1_THEME_VIDEO_ID) {
            let queued = QueuedSong::from_track(track, QueueSource::User);
            {
                let mut q = self.queue.lock().expect("queue");
                replace_queue_with_song(&mut q, queued.clone());
            }
            self.player.reset_failures();
            if self.resolve_and_play_async(&queued).await {
                return "Chevron seven... locked! 🌌 Dialing the SG-1 theme (local).".into();
            }
        }
        let attempts: [(&str, &[char]); 3] = [
            (SG1_THEME_URL, &['y']),
            ("Stargate SG-1 Opening season 1-2-3 HD", &['y']),
            ("Stargate SG-1 theme official", &[]),
        ];
        for (query, flags) in attempts {
            let set: HashSet<char> = flags.iter().copied().collect();
            if let ReplaceResult::Ok(_) = self.replace_with_first_hit_flags_async(query, &set).await
            {
                return "Chevron seven... locked! 🌌 Dialing the SG-1 theme.".into();
            }
        }
        "Chevron seven won't engage — SG-1 theme not in library and YouTube resolve failed.".into()
    }

    /// Append local library ids. Starts at the first insert when the player is idle.
    /// Returns how many ids resolved to a file.
    pub async fn enqueue_local_ids(&self, ids: &[String]) -> usize {
        let tracks: Vec<Track> = ids
            .iter()
            .filter_map(|id| self.local.song_by_id(id))
            .collect();
        let queued = tracks.len();
        if queued == 0 {
            return 0;
        }
        let was_idle = self.player.get_state() == PlayerState::Idle;
        let started = {
            let mut q = self.queue.lock().expect("queue");
            let mut first_at = None;
            for t in tracks {
                let at = q.add(QueuedSong::from_track(t, QueueSource::User));
                if first_at.is_none() {
                    first_at = Some(at);
                }
            }
            if was_idle {
                first_at.and_then(|at| q.play_at(at))
            } else {
                None
            }
        };
        if let Some(song) = started {
            self.player.reset_failures();
            let _ = self.resolve_and_play_async(&song).await;
        }
        queued
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

    /// Local + URL routing. None means "fall through to yt-dlp".
    fn search_local_and_urls(&self, q: &str, flags: &HashSet<char>) -> Result<Option<Track>, ()> {
        if flags.contains(&'s') {
            return Ok(stream_track(q)
                .or_else(|| self.stream_bridge.resolve_track(q))
                .filter(|t| !self.blocked(t)));
        }
        if flags.contains(&'y') {
            return Err(());
        }
        if !flags.contains(&'l') && YoutubeClient::can_handle(q) {
            return Err(());
        }
        if !flags.contains(&'l') && (is_spotify_ref(q) || is_tidal_url(q)) {
            if let Some(t) = self
                .stream_bridge
                .resolve_track(q)
                .filter(|t| !self.blocked(t))
            {
                return Ok(Some(t));
            }
        }
        if !flags.contains(&'l') && is_streamable_url(q) {
            return Ok(stream_track(q).filter(|t| !self.blocked(t)));
        }
        if !flags.contains(&'y') {
            if let Some(hit) = self.local.resolve_input(q) {
                match hit {
                    ResolveHit::Song(t) if !self.blocked(&t) => return Ok(Some(t)),
                    ResolveHit::Playlist { songs, .. } => {
                        if let Some(t) = songs.into_iter().find(|t| !self.blocked(t)) {
                            return Ok(Some(t));
                        }
                    }
                    ResolveHit::Song(_) => {}
                }
            }
            for t in self.local.search(q, 16) {
                if !self.blocked(&t) {
                    return Ok(Some(t));
                }
            }
        }
        if flags.contains(&'l') {
            return Ok(None);
        }
        Err(())
    }

    fn youtube_search_policy(q: &str, flags: &HashSet<char>) -> YoutubePolicy {
        if flags.contains(&'y') {
            if YoutubeClient::can_handle(q) {
                YoutubePolicy::Explicit
            } else {
                YoutubePolicy::Search
            }
        } else if YoutubeClient::can_handle(q) {
            YoutubePolicy::Explicit
        } else {
            YoutubePolicy::Search
        }
    }

    /// `-l` local only, `-y` YouTube, `-s` stream. Else: URL auto-route, then local, then ytsearch.
    pub fn search_first_flags(&self, query: &str, flags: &HashSet<char>) -> Option<Track> {
        let q = query.trim();
        if q.is_empty() {
            return None;
        }
        match self.search_local_and_urls(q, flags) {
            Ok(hit) => hit,
            Err(()) => self
                .youtube
                .search(q, 1, Self::youtube_search_policy(q, flags))
                .into_iter()
                .find(|t| !self.blocked(t)),
        }
    }

    /// Same as `search_first_flags` but yt-dlp runs on a blocking pool.
    pub async fn search_first_flags_async(
        &self,
        query: &str,
        flags: &HashSet<char>,
    ) -> Option<Track> {
        let q = query.trim();
        if q.is_empty() {
            return None;
        }
        match self.search_local_and_urls(q, flags) {
            Ok(hit) => hit,
            Err(()) => self
                .youtube
                .search_async(q, 1, Self::youtube_search_policy(q, flags))
                .await
                .into_iter()
                .find(|t| !self.blocked(t)),
        }
    }

    fn blocked(&self, t: &Track) -> bool {
        self.blacklist
            .as_ref()
            .is_some_and(|bl| bl.is_blacklisted(Some(&t.id), Some(&t.title), Some(&t.artist)))
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

    pub async fn song_by_id_platform_async(
        &self,
        song_id: &str,
        platform: Platform,
    ) -> Option<Track> {
        let id = song_id.trim();
        if id.is_empty() {
            return None;
        }
        match platform {
            Platform::Local => self.local.song_by_id(id).filter(|t| !self.blocked(t)),
            Platform::Youtube => self
                .youtube
                .detail_async(id)
                .await
                .filter(|t| !self.blocked(t)),
            Platform::Stream => stream_track(id)
                .or_else(|| self.stream_bridge.resolve_track(id))
                .filter(|t| !self.blocked(t)),
        }
    }

    pub fn resolve_and_play(&self, song: &QueuedSong) -> bool {
        self.play_song_at(song, 0.0)
    }

    pub async fn resolve_and_play_async(&self, song: &QueuedSong) -> bool {
        self.play_song_at_async(song, 0.0).await
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
        self.start_playback(song, &url, elapsed)
    }

    pub async fn play_song_at_async(&self, song: &QueuedSong, elapsed: f64) -> bool {
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
        let url = match self.playback_url_async(song).await {
            Some(u) => u,
            None => return false,
        };
        self.start_playback(song, &url, elapsed)
    }

    fn start_playback(&self, song: &QueuedSong, url: &str, elapsed: f64) -> bool {
        self.player.reset_failures();
        self.player
            .play(url, elapsed.max(0.0), song.duration as f64);
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
        self.arm_prefetch();
        true
    }

    fn arm_prefetch(&self) {
        let next = {
            let q = self.queue.lock().expect("queue");
            q.peek_next()
        };
        let Some(next) = next else {
            return;
        };
        if next.platform != Platform::Youtube {
            return;
        }
        let key = if next.id.is_empty() {
            next.url.clone()
        } else {
            next.id.clone()
        };
        if key.is_empty() {
            return;
        }
        let yt = self.youtube.clone();
        let cache = Arc::clone(&self.prefetch);
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        tokio::task::spawn_blocking(move || {
            if let Some(url) = yt.playback_url(&key) {
                *cache.lock().expect("prefetch") = Some((key, url));
            }
        });
    }

    pub async fn play_tracks(&self, tracks: Vec<Track>, mode: PlayMode) -> Option<QueuedSong> {
        if tracks.is_empty() {
            return None;
        }
        let songs: Vec<QueuedSong> = tracks
            .into_iter()
            .map(|t| QueuedSong::from_track(t, QueueSource::User))
            .collect();
        let first = {
            let mut q = self.queue.lock().expect("queue");
            replace_queue_with_tracks(&mut q, songs, mode)
        };
        let Some(first) = first else {
            return None;
        };
        self.player.reset_failures();
        let _ = self.resolve_and_play_async(&first).await;
        Some(first)
    }

    fn playback_url(&self, song: &QueuedSong) -> Option<String> {
        match song.platform {
            Platform::Local => {
                // Never trust client `url` (play-song body used to pass
                // `/etc/passwd` / `file:` / `concat:` straight to ffmpeg).
                let key = if !song.id.is_empty() {
                    song.id.as_str()
                } else {
                    song.url.as_str()
                };
                self.local
                    .get_song_url(key)
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

    async fn playback_url_async(&self, song: &QueuedSong) -> Option<String> {
        match song.platform {
            Platform::Local => self.playback_url(song),
            Platform::Youtube => {
                let key = if song.id.is_empty() {
                    song.url.clone()
                } else {
                    song.id.clone()
                };
                let cached = {
                    let g = self.yt_library.lock().expect("yt lib");
                    g.as_ref().and_then(|lib| lib.lookup(&key))
                };
                if let Some(p) = cached {
                    return Some(p);
                }
                {
                    let mut g = self.prefetch.lock().expect("prefetch");
                    if let Some((k, u)) = g.take() {
                        if k == key {
                            return Some(u);
                        }
                        *g = Some((k, u));
                    }
                }
                self.youtube.playback_url_async(&key).await
            }
            Platform::Stream => self.playback_url(song),
        }
    }

    fn play_next_attempts(&self) -> usize {
        self.queue
            .lock()
            .expect("queue")
            .size()
            .saturating_add(1)
            .clamp(1, 32)
    }

    pub fn play_next(&self) -> Option<QueuedSong> {
        let max = self.play_next_attempts();
        for _ in 0..max {
            let next = {
                let mut q = self.queue.lock().expect("queue");
                q.next()
            };
            let Some(song) = next else {
                return None;
            };
            if self.resolve_and_play(&song) {
                return Some(song);
            }
        }
        None
    }

    pub async fn play_next_async(&self) -> Option<QueuedSong> {
        let max = self.play_next_attempts();
        for _ in 0..max {
            let next = {
                let mut q = self.queue.lock().expect("queue");
                q.next()
            };
            let Some(song) = next else {
                return None;
            };
            if self.resolve_and_play_async(&song).await {
                return Some(song);
            }
        }
        None
    }

    pub fn replace_with_first_hit(&self, query: &str) -> ReplaceResult {
        self.replace_with_first_hit_flags(query, &HashSet::new())
    }

    /// `!test` / PHASE0 demo: Ella Langley *Choosin' Texas* (`DEFAULT_DEMO_VIDEO_ID`).
    /// Local `[videoId]` copy first, else YouTube. Sequential, play once.
    pub fn play_demo_track(&self) -> ReplaceResult {
        let id = crate::DEFAULT_DEMO_VIDEO_ID;
        if let Some(track) = self.find_local_by_video_id(id) {
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

    pub async fn play_demo_track_async(&self) -> ReplaceResult {
        let id = crate::DEFAULT_DEMO_VIDEO_ID;
        if let Some(track) = self.find_local_by_video_id(id) {
            let queued = QueuedSong::from_track(track.clone(), QueueSource::User);
            {
                let mut q = self.queue.lock().expect("queue");
                replace_queue_with_song(&mut q, queued.clone());
            }
            self.player.reset_failures();
            return if self.resolve_and_play_async(&queued).await {
                ReplaceResult::Ok(track)
            } else {
                ReplaceResult::CantPlay(track)
            };
        }
        self.replace_with_first_hit_flags_async(crate::DEFAULT_DEMO_VIDEO_URL, &HashSet::new())
            .await
    }

    fn find_local_by_video_id(&self, video_id: &str) -> Option<Track> {
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

    pub fn replace_with_first_hit_flags(
        &self,
        query: &str,
        flags: &HashSet<char>,
    ) -> ReplaceResult {
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

    pub async fn replace_with_first_hit_flags_async(
        &self,
        query: &str,
        flags: &HashSet<char>,
    ) -> ReplaceResult {
        let Some(track) = self.search_first_flags_async(query, flags).await else {
            return ReplaceResult::NoResults;
        };
        let queued = QueuedSong::from_track(track.clone(), QueueSource::User);
        {
            let mut q = self.queue.lock().expect("queue");
            replace_queue_with_song(&mut q, queued.clone());
        }
        self.player.reset_failures();
        if self.resolve_and_play_async(&queued).await {
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
        // -y never falls through to the local library. Without yt-dlp the hit is None.
        if let Some(hit) = st.search_first_flags("titanium", &y) {
            assert_eq!(hit.platform, Platform::Youtube);
        }

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
        assert!(
            st.song_by_id_platform("https://example.com/a.mp3", Platform::Stream)
                .is_some()
        );
        assert!(
            st.song_by_id_platform("http://127.0.0.1/a.mp3", Platform::Stream)
                .is_none()
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    fn song(id: &str, name: &str) -> QueuedSong {
        QueuedSong {
            id: id.into(),
            name: name.into(),
            artist: "A".into(),
            album: String::new(),
            platform: Platform::Local,
            url: format!("/tmp/{id}.mp3"),
            cover_url: String::new(),
            duration: 10,
            source: QueueSource::User,
        }
    }

    #[tokio::test]
    async fn vote_needs_a_majority_and_dedupes_uids() {
        let (dir, st) = tmp_station();
        {
            let mut q = st.queue.lock().unwrap();
            q.set_mode(PlayMode::Sequential);
            q.add(song("a", "one"));
            q.add(song("b", "two"));
            q.play();
        }
        let pending = st.cast_vote("u1", VoteAudience::Listeners(4)).await;
        assert_eq!(pending, "Vote to skip: 1/2 (need 1 more)");
        let again = st.cast_vote("u1", VoteAudience::Listeners(4)).await;
        assert_eq!(again, "Vote to skip: 1/2 (need 1 more)");
        let passed = st.cast_vote("u2", VoteAudience::Listeners(4)).await;
        assert!(passed.starts_with("Vote passed (2/2)"), "{passed}");
        let cur = st.queue.lock().unwrap().current().unwrap();
        assert_eq!(cur.id, "b");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn vote_refuses_the_demo_track_and_off_teamspeak() {
        let (dir, st) = tmp_station();
        {
            let mut q = st.queue.lock().unwrap();
            q.add(song(crate::DEFAULT_DEMO_VIDEO_ID, "Choosin' Texas"));
            q.play();
        }
        let msg = st.cast_vote("u1", VoteAudience::Listeners(1)).await;
        assert!(msg.contains("Chairman"), "{msg}");
        {
            let mut q = st.queue.lock().unwrap();
            q.clear();
            q.add(song("a", "one"));
            q.play();
        }
        let off = st.cast_vote("web:1", VoteAudience::NotOnTeamspeak).await;
        assert_eq!(off, "Vote can only be used in TeamSpeak");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn chevron7_dials_a_local_copy() {
        let (dir, st) = tmp_station();
        std::fs::write(dir.join("SG-1 [aafGXNWHGaw].mp3"), b"fake").unwrap();
        let msg = st.play_chevron7().await;
        assert!(msg.contains("locked"), "{msg}");
        assert!(msg.contains("local"), "{msg}");
        let q = st.queue.lock().unwrap();
        assert_eq!(q.get_mode(), PlayMode::Sequential);
        let cur = q.current().unwrap();
        assert!(cur.name.contains("aafGXNWHGaw"), "{}", cur.name);
        drop(q);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn enqueue_local_ids_starts_when_idle_and_appends_when_playing() {
        let dir = std::env::temp_dir().join(format!(
            "mp-st-enq-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("alpha.mp3"), b"fake").unwrap();
        std::fs::write(dir.join("beta.mp3"), b"fake").unwrap();
        let st = MusicStation::new(&dir, None);
        st.set_dry_run(true);
        let alpha = st.local.search("alpha", 1)[0].id.clone();
        let beta = st.local.search("beta", 1)[0].id.clone();
        let n = st.enqueue_local_ids(&[alpha.clone(), beta.clone()]).await;
        assert_eq!(n, 2);
        assert_eq!(st.player.get_state(), PlayerState::Playing);
        assert_eq!(st.queue.lock().unwrap().current().unwrap().id, alpha);
        let n2 = st.enqueue_local_ids(&[beta.clone()]).await;
        assert_eq!(n2, 1);
        assert_eq!(st.queue.lock().unwrap().current().unwrap().id, alpha);
        assert_eq!(st.enqueue_local_ids(&["missing".into()]).await, 0);
        let _ = std::fs::remove_dir_all(dir);
    }
}
