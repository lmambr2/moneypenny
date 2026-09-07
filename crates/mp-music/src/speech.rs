// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Park music, play a TTS wav on the shared player, restore on TrackEnd.
//! Skip never waits on this path — commands dispose first, then we air.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::station::MusicStation;
use crate::track::QueuedSong;

const SUPPRESS_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
struct Parked {
    song: QueuedSong,
    elapsed: f64,
}

struct Inner {
    saved: Option<Parked>,
    suppress: bool,
    suppress_at: Option<Instant>,
    path: Option<PathBuf>,
}

pub struct ChannelSpeech {
    station: Arc<MusicStation>,
    inner: Mutex<Inner>,
    speaking: AtomicBool,
    generation: AtomicU64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackEndKind {
    /// TTS (or pause/stop suppress) consumed this TrackEnd. Do not radio-advance.
    Tts,
    /// Ordinary music / bumper end.
    Music,
}

impl ChannelSpeech {
    pub fn new(station: Arc<MusicStation>) -> Arc<Self> {
        Arc::new(Self {
            station,
            inner: Mutex::new(Inner {
                saved: None,
                suppress: false,
                suppress_at: None,
                path: None,
            }),
            speaking: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        })
    }

    pub fn is_speaking(&self) -> bool {
        self.speaking.load(Ordering::SeqCst)
    }

    /// `hold_queue`: pause/stop acks — do not restore music after the wav.
    pub fn speak(&self, audio: &[u8], format: &str, hold_queue: bool) {
        if audio.is_empty() {
            return;
        }
        if !self.station.is_connected() && !self.station.player.dry_run() {
            tracing::debug!("tts: skip air — TeamSpeak not connected");
            return;
        }
        let path = match write_tts_file(audio, format) {
            Some(p) => p,
            None => {
                tracing::warn!("tts: could not write temp wav");
                return;
            }
        };

        let mut g = self.inner.lock().expect("speech");
        if hold_queue {
            g.saved = None;
            g.suppress = true;
            g.suppress_at = Some(Instant::now());
            if self.station.player.is_stt_ducked() {
                self.station.player.restore_from_stt_duck();
            }
        } else {
            g.suppress = false;
            g.suppress_at = None;
            if self.station.player.is_stt_ducked() {
                self.station.player.restore_from_stt_duck();
            }
            g.saved = park_current(&self.station);
        }
        if let Some(old) = g.path.replace(path.clone()) {
            let _ = std::fs::remove_file(old);
        }
        drop(g);

        self.generation.fetch_add(1, Ordering::SeqCst);
        self.speaking.store(true, Ordering::SeqCst);
        self.station.player.reset_failures();
        tracing::info!(path = %path.display(), hold_queue, "tts: airing in channel");
        self.station.player.play(path.to_str().unwrap_or(""), 0.0, 0.0);
        schedule_unlink(path, Duration::from_secs(120));
    }

    /// Call from the player TrackEnd handler. Restores parked music when needed.
    pub fn on_track_end(&self) -> TrackEndKind {
        let mut g = self.inner.lock().expect("speech");
        let speaking = self.speaking.swap(false, Ordering::SeqCst);
        if g.suppress {
            let fresh = g
                .suppress_at
                .is_some_and(|t| t.elapsed() <= SUPPRESS_TTL);
            g.suppress = false;
            g.suppress_at = None;
            g.saved = None;
            g.path = None;
            if fresh {
                tracing::info!("tts: holding queue after pause/stop reply");
                return TrackEndKind::Tts;
            }
            tracing::warn!("tts: stale pause/stop suppress — advancing normally");
            return TrackEndKind::Music;
        }
        if !speaking && g.saved.is_none() {
            return TrackEndKind::Music;
        }
        let saved = g.saved.take();
        g.path = None;
        drop(g);
        if let Some(parked) = saved {
            if !restore_parked(&self.station, parked) {
                tracing::warn!("tts: restore failed — leaving player idle");
            }
        }
        TrackEndKind::Tts
    }

    pub fn on_player_error(&self) {
        self.speaking.store(false, Ordering::SeqCst);
        let mut g = self.inner.lock().expect("speech");
        g.saved = None;
        g.suppress = false;
        g.path = None;
    }
}

fn park_current(station: &MusicStation) -> Option<Parked> {
    let song = station.queue.lock().ok()?.current()?;
    let elapsed = station.player.get_elapsed().max(0.0);
    Some(Parked { song, elapsed })
}

fn restore_parked(station: &MusicStation, parked: Parked) -> bool {
    let current = station.queue.lock().ok().and_then(|q| q.current());
    match current {
        Some(cur) if cur.id == parked.song.id => station.play_song_at(&cur, parked.elapsed),
        Some(_) => station.play_next().is_some(),
        None => false,
    }
}

fn write_tts_file(audio: &[u8], format: &str) -> Option<PathBuf> {
    let ext: String = format
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>()
        .to_ascii_lowercase();
    let ext = if ext.is_empty() { "wav".into() } else { ext };
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("moneypenny-tts-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let path = dir.join(format!("reply.{ext}"));
    std::fs::write(&path, audio).ok()?;
    Some(path)
}

fn schedule_unlink(path: PathBuf, after: Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(after);
        let _ = std::fs::remove_file(&path);
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir(dir);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::PlayQueue;
    use crate::track::{Platform, QueueSource, QueuedSong};

    fn song(id: &str) -> QueuedSong {
        QueuedSong {
            id: id.into(),
            name: id.into(),
            artist: "a".into(),
            album: String::new(),
            platform: Platform::Local,
            url: format!("/tmp/{id}.mp3"),
            cover_url: String::new(),
            duration: 120,
            source: QueueSource::User,
        }
    }

    #[test]
    fn pause_hold_does_not_restore() {
        let dir = std::env::temp_dir().join(format!("mp-speech-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let station = Arc::new(MusicStation::new(&dir, None));
        station.set_dry_run(true);
        station.set_connected(true);
        {
            let mut q = station.queue.lock().unwrap();
            q.add(song("s1"));
            q.play();
        }
        station.player.play("/tmp/s1.mp3", 0.0, 120.0);
        let speech = ChannelSpeech::new(Arc::clone(&station));
        speech.speak(b"RIFF....wav", "wav", true);
        assert!(speech.is_speaking());
        assert_eq!(speech.on_track_end(), TrackEndKind::Tts);
        assert!(!speech.is_speaking());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn skip_does_not_wait_on_speak() {
        // Speak is fire-and-forget: queue mutation from skip already happened.
        let dir = std::env::temp_dir().join(format!("mp-speech-skip-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let station = Arc::new(MusicStation::new(&dir, None));
        station.set_dry_run(true);
        station.set_connected(true);
        {
            let mut q = station.queue.lock().unwrap();
            q.add(song("a"));
            q.add(song("b"));
            q.play();
        }
        let speech = ChannelSpeech::new(Arc::clone(&station));
        let _ = station.play_next();
        assert_eq!(
            station.queue.lock().unwrap().current().unwrap().id,
            "b"
        );
        speech.speak(b"RIFF skip", "wav", false);
        assert!(speech.is_speaking());
        assert_eq!(speech.on_track_end(), TrackEndKind::Tts);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn music_track_end_is_fallthrough() {
        let dir = std::env::temp_dir().join(format!("mp-speech-m-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let station = Arc::new(MusicStation::new(&dir, None));
        station.set_dry_run(true);
        let speech = ChannelSpeech::new(station);
        assert_eq!(speech.on_track_end(), TrackEndKind::Music);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unused_queue_touch() {
        let _ = PlayQueue::new();
    }
}
