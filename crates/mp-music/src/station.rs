// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Queue + local library + player. The executor talks to this, not ffmpeg.

use std::sync::{Arc, Mutex};

use crate::blacklist::PlaybackBlacklist;
use crate::local::{LocalProvider, ResolveHit};
use crate::player::{AudioPlayer, PlayerEvent, PlayerState};
use crate::queue::{replace_queue_with_song, PlayMode, PlayQueue};
use crate::track::{Platform, QueuedSong, QueueSource, Track};

pub struct UserPause {
    pub song_id: String,
    pub elapsed: f64,
}

pub struct MusicStation {
    pub queue: Mutex<PlayQueue>,
    pub player: AudioPlayer,
    pub local: LocalProvider,
    pub blacklist: Option<Arc<PlaybackBlacklist>>,
    pub user_pause: Mutex<Option<UserPause>>,
    connected: Mutex<bool>,
}

impl MusicStation {
    pub fn new(music_dir: impl AsRef<std::path::Path>, blacklist: Option<Arc<PlaybackBlacklist>>) -> Self {
        Self {
            queue: Mutex::new(PlayQueue::new()),
            player: AudioPlayer::new(),
            local: LocalProvider::new(music_dir),
            blacklist,
            user_pause: Mutex::new(None),
            connected: Mutex::new(true),
        }
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
        let q = query.trim();
        if q.is_empty() {
            return None;
        }
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
        None
    }

    fn blocked(&self, t: &Track) -> bool {
        self.blacklist.as_ref().is_some_and(|bl| {
            bl.is_blacklisted(Some(&t.id), Some(&t.title), Some(&t.artist))
        })
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
        let url = if !song.url.is_empty() {
            song.url.clone()
        } else if song.platform == Platform::Local {
            match self.local.get_song_url(&song.id) {
                Some(p) => p.to_string_lossy().into_owned(),
                None => return false,
            }
        } else {
            return false;
        };
        self.player.reset_failures();
        self.player.play(&url, elapsed.max(0.0), song.duration as f64);
        true
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
        let Some(track) = self.search_first(query) else {
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
                let url = if !cur.url.is_empty() {
                    cur.url.clone()
                } else {
                    self.local
                        .get_song_url(&cur.id)
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_default()
                };
                if url.is_empty() {
                    return "Could not resume — try play again".into();
                }
                self.player.play(&url, elapsed, cur.duration as f64);
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
