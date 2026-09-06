// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! ffmpeg PCM → Opus 20 ms music frames. Port of `bot/src/audio/player.ts`.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::broadcast;

use crate::ffmpeg::{
    build_ffmpeg_args, classify_stall, clamp_music_opus_bitrate_kbps, StallCheckInput,
    FRAME_DURATION_MS, MUSIC_OPUS_BITRATE_KBPS_DEFAULT, PCM_FRAME_BYTES,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerState {
    Idle,
    Playing,
    Paused,
}

#[derive(Debug, Clone)]
pub enum PlayerEvent {
    Frame(Vec<u8>),
    TrackEnd,
    Error(String),
}

struct Inner {
    state: PlayerState,
    volume: f64,
    pcm: VecDeque<u8>,
    session: u64,
    encoder: Option<mp_audio::NativeOpus>,
    consecutive_failures: u32,
    frames_played: u64,
    play_started: Option<Instant>,
    current_url: String,
    seek_offset: f64,
    duration: f64,
    empty_attempts: u32,
    ffmpeg_alive: bool,
    spawn_failed: bool,
    bitrate_kbps: u32,
    play_volume_floor: Option<f64>,
    child_kill_std: Option<std::sync::mpsc::Sender<()>>,
}

pub struct AudioPlayer {
    inner: Arc<Mutex<Inner>>,
    events: broadcast::Sender<PlayerEvent>,
    loop_running: Arc<AtomicBool>,
    dry_run: AtomicBool,
}

impl AudioPlayer {
    pub fn new() -> Self {
        let encoder = mp_audio::NativeOpus::new(48_000, 2).ok();
        let mut enc = encoder;
        if let Some(ref mut e) = enc {
            let _ = e.set_bitrate_bps((MUSIC_OPUS_BITRATE_KBPS_DEFAULT * 1000) as i32);
        }
        let (events, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(Mutex::new(Inner {
                state: PlayerState::Idle,
                volume: 30.0,
                pcm: VecDeque::new(),
                session: 0,
                encoder: enc,
                consecutive_failures: 0,
                frames_played: 0,
                play_started: None,
                current_url: String::new(),
                seek_offset: 0.0,
                duration: 0.0,
                empty_attempts: 0,
                ffmpeg_alive: false,
                spawn_failed: false,
                bitrate_kbps: MUSIC_OPUS_BITRATE_KBPS_DEFAULT,
                play_volume_floor: None,
                child_kill_std: None,
            })),
            events,
            loop_running: Arc::new(AtomicBool::new(false)),
            dry_run: AtomicBool::new(false),
        }
    }

    pub fn set_dry_run(&self, dry: bool) {
        self.dry_run.store(dry, Ordering::SeqCst);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PlayerEvent> {
        self.events.subscribe()
    }

    pub fn get_state(&self) -> PlayerState {
        self.inner.lock().expect("player").state
    }

    pub fn set_volume(&self, vol: i32) {
        self.inner.lock().expect("player").volume = vol.clamp(0, 100) as f64;
    }

    pub fn get_volume(&self) -> i32 {
        self.inner.lock().expect("player").volume.round() as i32
    }

    pub fn reset_failures(&self) {
        self.inner.lock().expect("player").consecutive_failures = 0;
    }

    pub fn get_elapsed(&self) -> f64 {
        let g = self.inner.lock().expect("player");
        g.seek_offset + (g.frames_played as f64 * FRAME_DURATION_MS as f64) / 1000.0
    }

    pub fn pause(&self) {
        let mut g = self.inner.lock().expect("player");
        if g.state == PlayerState::Playing {
            g.state = PlayerState::Paused;
        }
    }

    pub fn resume(&self) {
        let mut g = self.inner.lock().expect("player");
        if g.state == PlayerState::Paused {
            g.state = PlayerState::Playing;
        }
    }

    pub fn set_bitrate_kbps(&self, kbps: i32) {
        let kbps = clamp_music_opus_bitrate_kbps(kbps);
        let mut g = self.inner.lock().expect("player");
        g.bitrate_kbps = kbps;
        if let Some(ref mut enc) = g.encoder {
            let bps = if kbps == 0 { 0 } else { (kbps * 1000) as i32 };
            let _ = enc.set_bitrate_bps(bps);
        }
    }

    pub fn stop(&self) {
        let mut g = self.inner.lock().expect("player");
        g.session += 1;
        g.pcm.clear();
        g.state = PlayerState::Idle;
        g.ffmpeg_alive = false;
        g.play_volume_floor = None;
        g.play_started = None;
        g.current_url.clear();
        g.frames_played = 0;
        g.empty_attempts = 0;
        if let Some(tx) = g.child_kill_std.take() {
            let _ = tx.send(());
        }
    }

    pub fn play(&self, url: &str, seek_seconds: f64, song_duration: f64) {
        self.stop();
        if self.dry_run.load(Ordering::SeqCst) {
            let mut g = self.inner.lock().expect("player");
            g.state = PlayerState::Playing;
            g.current_url = url.to_string();
            g.seek_offset = seek_seconds;
            g.duration = song_duration;
            g.play_started = Some(Instant::now());
            return;
        }

        let session;
        {
            let mut g = self.inner.lock().expect("player");
            if g.consecutive_failures >= 3 {
                g.state = PlayerState::Idle;
                let _ = self.events.send(PlayerEvent::Error("ffmpeg unavailable".into()));
                return;
            }
            session = g.session;
            g.current_url = url.to_string();
            g.seek_offset = seek_seconds;
            g.duration = song_duration;
            g.frames_played = 0;
            g.empty_attempts = 0;
            g.spawn_failed = false;
            g.play_started = Some(Instant::now());
            g.state = PlayerState::Playing;
            g.ffmpeg_alive = true;
        }

        let args = build_ffmpeg_args(url, seek_seconds, None, None);
        let (kill_tx, kill_rx) = std::sync::mpsc::channel::<()>();
        self.inner.lock().expect("player").child_kill_std = Some(kill_tx);

        let inner = Arc::clone(&self.inner);
        let events = self.events.clone();
        let url_log = url.to_string();
        // Dedicated thread: tsclient-rs makes the bot loop `!Send`, so a
        // `tokio::spawn` ffmpeg task may never be polled on this runtime.
        std::thread::Builder::new()
            .name("mp-ffmpeg".into())
            .spawn(move || {
                tracing::info!(url = %url_log, "ffmpeg start");
                let mut cmd = std::process::Command::new("ffmpeg");
                cmd.args(&args)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null());
                let mut child = match cmd.spawn() {
                    Ok(c) => c,
                    Err(e) => {
                        let mut g = inner.lock().expect("player");
                        if g.session == session {
                            g.spawn_failed = true;
                            g.ffmpeg_alive = false;
                            g.consecutive_failures += 1;
                            g.state = PlayerState::Idle;
                        }
                        let _ = events.send(PlayerEvent::Error(e.to_string()));
                        return;
                    }
                };
                let mut stdout = child.stdout.take().expect("stdout");
                let mut buf = vec![0u8; 8192];
                loop {
                    if kill_rx.try_recv().is_ok() {
                        let _ = child.kill();
                        break;
                    }
                    use std::io::Read;
                    match stdout.read(&mut buf) {
                        Ok(0) => break,
                        Err(_) => break,
                        Ok(n) => loop {
                            let mut g = inner.lock().expect("player");
                            if g.session != session {
                                drop(g);
                                let _ = child.kill();
                                return;
                            }
                            if g.pcm.len() <= 640 * 1024 {
                                g.pcm.extend(buf[..n].iter().copied());
                                break;
                            }
                            drop(g);
                            std::thread::sleep(std::time::Duration::from_millis(5));
                        },
                    }
                }
                let _ = child.wait();
                let mut g = inner.lock().expect("player");
                if g.session == session {
                    g.ffmpeg_alive = false;
                }
                tracing::info!("ffmpeg exit");
            })
            .expect("ffmpeg thread");

        self.ensure_frame_loop();
    }

    /// Tests / dry-run: pretend the current track ended.
    pub fn emit_track_end_for_test(&self) {
        let mut g = self.inner.lock().expect("player");
        g.state = PlayerState::Idle;
        let _ = self.events.send(PlayerEvent::TrackEnd);
    }

    fn ensure_frame_loop(&self) {
        if self
            .loop_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let inner = Arc::clone(&self.inner);
        let events = self.events.clone();
        let running = Arc::clone(&self.loop_running);
        std::thread::Builder::new()
            .name("mp-frames".into())
            .spawn(move || {
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(FRAME_DURATION_MS));
                    let ended = {
                        let mut g = inner.lock().expect("player");
                        if g.state == PlayerState::Paused {
                            continue;
                        }
                        if g.state != PlayerState::Playing {
                            if !g.ffmpeg_alive && g.pcm.len() < PCM_FRAME_BYTES {
                                running.store(false, Ordering::SeqCst);
                                break;
                            }
                            continue;
                        }
                        send_next_frame(&mut g, &events);
                        stall_or_end(&mut g, &events)
                    };
                    if ended {
                        running.store(false, Ordering::SeqCst);
                        break;
                    }
                }
            })
            .expect("frame thread");
    }
}

fn send_next_frame(g: &mut Inner, events: &broadcast::Sender<PlayerEvent>) {
    if g.pcm.len() < PCM_FRAME_BYTES {
        return;
    }
    let frame: Vec<u8> = g.pcm.drain(..PCM_FRAME_BYTES).collect();
    let floor = g.play_volume_floor.unwrap_or(0.0);
    let adjusted = match mp_audio::pcm_apply_playback_gain(&frame, g.volume, false, 2.0, floor) {
        Ok(a) => a,
        Err(e) => {
            let _ = events.send(PlayerEvent::Error(e.to_string()));
            return;
        }
    };
    let Some(ref mut enc) = g.encoder else {
        let _ = events.send(PlayerEvent::Error("opus encoder missing".into()));
        return;
    };
    match enc.encode(&adjusted) {
        Ok(opus) => {
            let _ = events.send(PlayerEvent::Frame(opus));
            g.frames_played += 1;
            if g.frames_played >= 50 {
                g.consecutive_failures = 0;
            }
        }
        Err(e) => {
            let _ = events.send(PlayerEvent::Error(e.to_string()));
        }
    }
}

fn stall_or_end(g: &mut Inner, events: &broadcast::Sender<PlayerEvent>) -> bool {
    let elapsed = g.seek_offset + (g.frames_played as f64 * FRAME_DURATION_MS as f64) / 1000.0;
    let is_near_end = if g.duration > 0.0 {
        g.duration - elapsed <= 5.0
    } else {
        elapsed >= 45.0
    };
    if g.ffmpeg_alive && g.pcm.len() < PCM_FRAME_BYTES {
        g.empty_attempts += 1;
        let wall = g
            .play_started
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        let verdict = classify_stall(StallCheckInput {
            empty_frame_attempts: g.empty_attempts,
            near_end_attempts: 250,
            mid_track_attempts: 500,
            is_near_end,
            wall_elapsed_sec: wall,
        });
        if verdict != crate::ffmpeg::StallVerdict::Continue {
            g.state = PlayerState::Idle;
            g.ffmpeg_alive = false;
            g.consecutive_failures = 0;
            if let Some(tx) = g.child_kill_std.take() {
                let _ = tx.send(());
            }
            let _ = events.send(PlayerEvent::TrackEnd);
            return true;
        }
    } else {
        g.empty_attempts = 0;
    }
    if !g.ffmpeg_alive && g.pcm.len() < PCM_FRAME_BYTES {
        if g.state != PlayerState::Idle {
            g.state = PlayerState::Idle;
            if !g.spawn_failed {
                g.consecutive_failures = 0;
                let _ = events.send(PlayerEvent::TrackEnd);
            }
        }
        return true;
    }
    false
}

impl Default for AudioPlayer {
    fn default() -> Self {
        Self::new()
    }
}

// silence unused import if rustc complains

