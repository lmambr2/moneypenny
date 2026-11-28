// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! ffmpeg PCM → Opus 20 ms music frames. Port of `bot/src/audio/player.ts`.

use std::collections::VecDeque;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::broadcast;

use crate::ffmpeg::{
    FRAME_DURATION_MS, MUSIC_OPUS_BITRATE_KBPS_DEFAULT, PCM_FRAME_BYTES, StallAction,
    StallCheckInput, build_ffmpeg_args, build_ffmpeg_pipe_args, clamp_music_opus_bitrate_kbps,
    classify_stall, decide_stall_action, is_near_end_of_track, mid_track_stall_attempts,
    stall_action_for_url,
};
use crate::youtube::{YoutubeClient, yt_dlp_binary, ytdlp_chunk_args};

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
    NowPlaying {
        name: String,
        artist: String,
        album: String,
    },
    Idle,
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
    stt_duck_active: bool,
    stt_duck_level: f64,
    stall_resumes: u32,
    resuming: bool,
}

/// Opus bytes, called on the frame thread. Must not touch the player lock.
type FrameSink = Arc<dyn Fn(Vec<u8>) + Send + Sync>;

pub struct AudioPlayer {
    inner: Arc<Mutex<Inner>>,
    events: broadcast::Sender<PlayerEvent>,
    frame_sink: Arc<Mutex<Option<FrameSink>>>,
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
        // ~40s of 20ms frames. Chat/yt-dlp must not be able to overflow this
        // while the bot loop is busy — Lagged = dropped Opus = stutter.
        let (events, _) = broadcast::channel(2048);
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
                stt_duck_active: false,
                stt_duck_level: 15.0,
                stall_resumes: 0,
                resuming: false,
            })),
            events,
            frame_sink: Arc::new(Mutex::new(None)),
            loop_running: Arc::new(AtomicBool::new(false)),
            dry_run: AtomicBool::new(false),
        }
    }

    /// Music frames go here instead of the broadcast. The bot loop stays off
    /// the 20 ms path.
    pub fn set_frame_sink(&self, sink: Arc<dyn Fn(Vec<u8>) + Send + Sync>) {
        *self.frame_sink.lock().expect("frame sink") = Some(sink);
    }

    pub fn set_dry_run(&self, dry: bool) {
        self.dry_run.store(dry, Ordering::SeqCst);
    }

    pub fn dry_run(&self) -> bool {
        self.dry_run.load(Ordering::SeqCst)
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

    /// Attenuate output while STT capture runs. No-op when not playing.
    pub fn duck_for_stt(&self, duck_level: i32) -> bool {
        let mut g = self.inner.lock().expect("player");
        if g.state != PlayerState::Playing {
            return false;
        }
        g.stt_duck_active = true;
        g.stt_duck_level = f64::from(duck_level.clamp(0, 100));
        true
    }

    pub fn restore_from_stt_duck(&self) -> bool {
        let mut g = self.inner.lock().expect("player");
        if !g.stt_duck_active {
            return false;
        }
        g.stt_duck_active = false;
        true
    }

    pub fn is_stt_ducked(&self) -> bool {
        self.inner.lock().expect("player").stt_duck_active
    }

    pub fn reset_failures(&self) {
        self.inner.lock().expect("player").consecutive_failures = 0;
    }

    pub fn loaded_url(&self) -> String {
        self.inner.lock().expect("player").current_url.clone()
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
        self.stop_inner(true);
    }

    fn stop_inner(&self, announce_idle: bool) {
        let mut g = self.inner.lock().expect("player");
        g.session += 1;
        g.pcm.clear();
        g.state = PlayerState::Idle;
        g.ffmpeg_alive = false;
        g.play_volume_floor = None;
        g.stt_duck_active = false;
        g.play_started = None;
        g.current_url.clear();
        g.frames_played = 0;
        g.empty_attempts = 0;
        if let Some(tx) = g.child_kill_std.take() {
            let _ = tx.send(());
        }
        drop(g);
        if announce_idle {
            let _ = self.events.send(PlayerEvent::Idle);
        }
    }

    /// Restart the current URL at `seconds`. No-op when nothing is loaded or the position is invalid.
    pub fn seek(&self, seconds: f64) -> bool {
        if !seconds.is_finite() || seconds < 0.0 {
            return false;
        }
        let (url, duration, floor) = {
            let g = self.inner.lock().expect("player");
            (g.current_url.clone(), g.duration, g.play_volume_floor)
        };
        if url.is_empty() {
            return false;
        }
        self.play_with_floor(&url, seconds, duration, floor);
        true
    }

    pub fn announce_track(&self, name: &str, artist: &str, album: &str) {
        let _ = self.events.send(PlayerEvent::NowPlaying {
            name: name.to_string(),
            artist: artist.to_string(),
            album: album.to_string(),
        });
    }

    pub fn play(&self, url: &str, seek_seconds: f64, song_duration: f64) {
        self.play_with_floor(url, seek_seconds, song_duration, None);
    }

    pub fn play_with_floor(
        &self,
        url: &str,
        seek_seconds: f64,
        song_duration: f64,
        volume_pct_floor: Option<f64>,
    ) {
        self.stop_inner(false);
        if let Some(f) = volume_pct_floor {
            self.inner.lock().expect("player").play_volume_floor = Some(f.clamp(0.0, 100.0));
        }
        if self.dry_run.load(Ordering::SeqCst) {
            let mut g = self.inner.lock().expect("player");
            g.state = PlayerState::Playing;
            g.current_url = url.to_string();
            g.seek_offset = seek_seconds;
            g.duration = song_duration;
            g.play_started = Some(Instant::now());
            g.stall_resumes = 0;
            return;
        }

        let session;
        {
            let mut g = self.inner.lock().expect("player");
            if g.consecutive_failures >= 3 {
                g.state = PlayerState::Idle;
                let _ = self
                    .events
                    .send(PlayerEvent::Error("ffmpeg unavailable".into()));
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
            g.stall_resumes = 0;
        }

        spawn_ffmpeg_reader(
            Arc::clone(&self.inner),
            self.events.clone(),
            url.to_string(),
            seek_seconds,
            session,
        );
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
        let frame_sink = Arc::clone(&self.frame_sink);
        std::thread::Builder::new()
            .name("mp-frames".into())
            .spawn(move || {
                // Deadline clock, same as the Node player. sleep(20ms) plus the
                // encode runs long, so packets drift apart and TeamSpeak inserts
                // a one-frame gap. Absolute sleep keeps one late wake from
                // stretching the next wait.
                tighten_timer_slack();
                let frame = std::time::Duration::from_millis(FRAME_DURATION_MS);
                let mut next = Instant::now();
                loop {
                    let now = Instant::now();
                    let behind = now.saturating_duration_since(next);
                    if behind > std::time::Duration::from_millis(MAX_CATCHUP_BEHIND_MS) {
                        let drop = late_frame_drop_count(behind.as_millis() as u64);
                        if drop > 0 {
                            let mut g = inner.lock().expect("player");
                            let dropped = discard_pcm_frames(&mut g, drop);
                            if dropped > 0 {
                                tracing::debug!(
                                    behind_ms = behind.as_millis() as u64,
                                    dropped,
                                    "dropped late frames"
                                );
                            }
                        }
                        next = Instant::now();
                    }
                    next += frame;
                    sleep_until(next);
                    let (ended, resume, opus) = {
                        let mut g = inner.lock().expect("player");
                        if g.state != PlayerState::Playing {
                            next = Instant::now();
                            if g.state != PlayerState::Paused
                                && !g.ffmpeg_alive
                                && g.pcm.len() < PCM_FRAME_BYTES
                            {
                                running.store(false, Ordering::SeqCst);
                                break;
                            }
                            continue;
                        }
                        let opus = send_next_frame(&mut g, &events);
                        let ended = stall_or_end(&mut g, &events);
                        let resume = if g.resuming {
                            g.resuming = false;
                            Some((g.current_url.clone(), g.seek_offset, g.session))
                        } else {
                            None
                        };
                        (ended, resume, opus)
                    };
                    if let Some(opus) = opus {
                        let sink = frame_sink.lock().expect("frame sink").clone();
                        dispatch_opus(&events, sink.as_ref(), opus);
                    }
                    if let Some((url, seek, session)) = resume {
                        spawn_ffmpeg_reader(Arc::clone(&inner), events.clone(), url, seek, session);
                    }
                    if ended {
                        running.store(false, Ordering::SeqCst);
                        break;
                    }
                }
            })
            .expect("frame thread");
    }
}

fn tighten_timer_slack() {
    unsafe {
        libc::prctl(libc::PR_SET_TIMERSLACK, 1 as libc::c_ulong);
    }
}

/// Sleep until `deadline` on CLOCK_MONOTONIC. A relative sleep that overshoots
/// is added onto the next frame; an absolute sleep is not.
fn sleep_until(deadline: Instant) {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    let got = unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    let remain = deadline.saturating_duration_since(Instant::now());
    if remain.is_zero() {
        return;
    }
    if got != 0 {
        std::thread::sleep(remain);
        return;
    }
    let nsec = ts.tv_nsec as u128 + remain.as_nanos();
    ts.tv_sec += (nsec / 1_000_000_000) as libc::time_t;
    ts.tv_nsec = (nsec % 1_000_000_000) as libc::c_long;
    loop {
        let rc = unsafe {
            libc::clock_nanosleep(
                libc::CLOCK_MONOTONIC,
                libc::TIMER_ABSTIME,
                &ts,
                std::ptr::null_mut(),
            )
        };
        if rc != libc::EINTR {
            break;
        }
    }
}

fn dispatch_opus(events: &broadcast::Sender<PlayerEvent>, sink: Option<&FrameSink>, opus: Vec<u8>) {
    if let Some(sink) = sink {
        sink(opus);
    } else {
        let _ = events.send(PlayerEvent::Frame(opus));
    }
}

/// If the frame loop is later than this, drop PCM instead of bursting UDP.
const MAX_CATCHUP_BEHIND_MS: u64 = 80;

/// Extra 20ms frames to discard when the loop ran late. Keep one frame to send now.
fn late_frame_drop_count(behind_ms: u64) -> u32 {
    if behind_ms <= FRAME_DURATION_MS * 2 {
        return 0;
    }
    let n = (behind_ms / FRAME_DURATION_MS).saturating_sub(1);
    u32::try_from(n).unwrap_or(u32::MAX).min(50)
}

fn discard_pcm_frames(g: &mut Inner, n: u32) -> u32 {
    let have = g.pcm.len() / PCM_FRAME_BYTES;
    let n = (n as usize).min(have);
    if n == 0 {
        return 0;
    }
    let bytes = n * PCM_FRAME_BYTES;
    g.pcm.drain(..bytes);
    g.frames_played += n as u64;
    n as u32
}

struct DecodePipe {
    ffmpeg: Child,
    /// yt-dlp feeding ffmpeg. Absent for a local file or a direct HTTP stream.
    feeder: Option<Child>,
    pgid: u32,
}

fn kill_process_group(pgid: u32) {
    if pgid == 0 {
        return;
    }
    unsafe {
        libc::kill(-(pgid as i32), libc::SIGKILL);
    }
}

fn reap_decode_pipe(pipe: &mut DecodePipe) {
    let _ = pipe.ffmpeg.wait();
    if let Some(feeder) = pipe.feeder.as_mut() {
        let _ = feeder.kill();
        let _ = feeder.wait();
    }
}

/// YouTube / X / Bandcamp: yt-dlp pulls ≤8 MB ranges and ffmpeg decodes the pipe.
/// Other URLs are opened by ffmpeg directly. Feeder and ffmpeg share a process
/// group so stop kills both even when the reader is blocked in `read`.
fn spawn_decode_pipe(url: &str, seek_seconds: f64) -> Result<DecodePipe, String> {
    if YoutubeClient::can_handle(url) {
        let bin = yt_dlp_binary().ok_or_else(|| "yt-dlp missing".to_string())?;
        let mut ytdlp_cmd = Command::new(bin);
        ytdlp_cmd
            .args(ytdlp_chunk_args(url))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0);
        let mut ytdlp = ytdlp_cmd.spawn().map_err(|e| e.to_string())?;
        let pgid = ytdlp.id();
        let ytdlp_out = ytdlp
            .stdout
            .take()
            .ok_or_else(|| "yt-dlp stdout".to_string())?;
        let mut ffmpeg_cmd = Command::new("ffmpeg");
        ffmpeg_cmd
            .args(build_ffmpeg_pipe_args(seek_seconds))
            .stdin(ytdlp_out)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(pgid as i32);
        match ffmpeg_cmd.spawn() {
            Ok(ffmpeg) => Ok(DecodePipe {
                ffmpeg,
                feeder: Some(ytdlp),
                pgid,
            }),
            Err(e) => {
                kill_process_group(pgid);
                let _ = ytdlp.wait();
                Err(e.to_string())
            }
        }
    } else {
        let mut cmd = Command::new("ffmpeg");
        cmd.args(build_ffmpeg_args(url, seek_seconds, None, None))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0);
        let ffmpeg = cmd.spawn().map_err(|e| e.to_string())?;
        let pgid = ffmpeg.id();
        Ok(DecodePipe {
            ffmpeg,
            feeder: None,
            pgid,
        })
    }
}

fn fail_spawn(
    inner: &Arc<Mutex<Inner>>,
    events: &broadcast::Sender<PlayerEvent>,
    session: u64,
    err: &str,
) {
    let mut g = inner.lock().expect("player");
    if g.session == session {
        g.spawn_failed = true;
        g.ffmpeg_alive = false;
        g.consecutive_failures += 1;
        g.state = PlayerState::Idle;
        let _ = events.send(PlayerEvent::TrackEnd);
    }
    let _ = events.send(PlayerEvent::Error(err.to_string()));
}

fn spawn_ffmpeg_reader(
    inner: Arc<Mutex<Inner>>,
    events: broadcast::Sender<PlayerEvent>,
    url: String,
    seek_seconds: f64,
    session: u64,
) {
    let (kill_tx, kill_rx) = std::sync::mpsc::channel::<()>();
    inner.lock().expect("player").child_kill_std = Some(kill_tx.clone());
    std::thread::Builder::new()
        .name("mp-ffmpeg".into())
        .spawn(move || {
            let chunked = YoutubeClient::can_handle(&url);
            tracing::info!(url = %url, chunked, "ffmpeg start");
            let mut pipe = match spawn_decode_pipe(&url, seek_seconds) {
                Ok(p) => p,
                Err(e) => {
                    fail_spawn(&inner, &events, session, &e);
                    return;
                }
            };
            let pgid = pipe.pgid;
            let watcher = std::thread::spawn(move || {
                let _ = kill_rx.recv();
                kill_process_group(pgid);
            });
            let mut stdout = match pipe.ffmpeg.stdout.take() {
                Some(s) => s,
                None => {
                    kill_process_group(pgid);
                    reap_decode_pipe(&mut pipe);
                    let _ = kill_tx.send(());
                    let _ = watcher.join();
                    fail_spawn(&inner, &events, session, "ffmpeg stdout");
                    return;
                }
            };
            let mut buf = vec![0u8; 8192];
            'read: loop {
                use std::io::Read;
                match stdout.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => loop {
                        let mut g = inner.lock().expect("player");
                        if g.session != session {
                            break 'read;
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
            kill_process_group(pgid);
            reap_decode_pipe(&mut pipe);
            let _ = kill_tx.send(());
            let _ = watcher.join();
            let mut g = inner.lock().expect("player");
            if g.session == session {
                g.ffmpeg_alive = false;
            }
            tracing::info!("ffmpeg exit");
        })
        .expect("ffmpeg thread");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_frames_drop_only_once_the_loop_is_past_two_periods() {
        assert_eq!(late_frame_drop_count(0), 0);
        assert_eq!(late_frame_drop_count(20), 0);
        assert_eq!(late_frame_drop_count(40), 0);
        assert_eq!(late_frame_drop_count(41), 1);
        assert_eq!(late_frame_drop_count(200), 9);
        assert_eq!(late_frame_drop_count(10_000), 50);
    }

    #[test]
    fn kill_process_group_stops_a_live_child() {
        let mut cmd = Command::new("sleep");
        cmd.arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        let mut child = cmd.spawn().expect("sleep");
        let pgid = child.id();
        std::thread::sleep(std::time::Duration::from_millis(50));
        kill_process_group(pgid);
        let status = child.wait().expect("reap");
        assert!(!status.success());
    }

    #[test]
    fn opus_with_a_sink_does_not_also_broadcast() {
        let (events, mut rx) = broadcast::channel(4);
        let n = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let n2 = Arc::clone(&n);
        let sink: FrameSink = Arc::new(move |opus| {
            assert_eq!(opus, vec![1, 2, 3]);
            n2.fetch_add(1, Ordering::SeqCst);
        });
        dispatch_opus(&events, Some(&sink), vec![1, 2, 3]);
        assert_eq!(n.load(Ordering::SeqCst), 1);
        assert!(rx.try_recv().is_err());

        dispatch_opus(&events, None, vec![9]);
        match rx.try_recv() {
            Ok(PlayerEvent::Frame(b)) => assert_eq!(b, vec![9]),
            other => panic!("expected frame, got {other:?}"),
        }
    }
}

fn send_next_frame(g: &mut Inner, events: &broadcast::Sender<PlayerEvent>) -> Option<Vec<u8>> {
    if g.pcm.len() < PCM_FRAME_BYTES {
        return None;
    }
    let frame: Vec<u8> = g.pcm.drain(..PCM_FRAME_BYTES).collect();
    let floor = g.play_volume_floor.unwrap_or(0.0);
    let adjusted = match mp_audio::pcm_apply_playback_gain(
        &frame,
        g.volume,
        g.stt_duck_active,
        g.stt_duck_level,
        floor,
    ) {
        Ok(a) => a,
        Err(e) => {
            let _ = events.send(PlayerEvent::Error(e.to_string()));
            return None;
        }
    };
    let Some(ref mut enc) = g.encoder else {
        let _ = events.send(PlayerEvent::Error("opus encoder missing".into()));
        return None;
    };
    match enc.encode(&adjusted) {
        Ok(opus) => {
            g.frames_played += 1;
            if g.frames_played >= 50 {
                g.consecutive_failures = 0;
            }
            Some(opus)
        }
        Err(e) => {
            let _ = events.send(PlayerEvent::Error(e.to_string()));
            None
        }
    }
}

fn stall_or_end(g: &mut Inner, events: &broadcast::Sender<PlayerEvent>) -> bool {
    let elapsed = g.seek_offset + (g.frames_played as f64 * FRAME_DURATION_MS as f64) / 1000.0;
    let is_near_end = is_near_end_of_track(g.duration, elapsed);
    if g.ffmpeg_alive && g.pcm.len() < PCM_FRAME_BYTES {
        g.empty_attempts += 1;
        let wall = g
            .play_started
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        let verdict = classify_stall(StallCheckInput {
            empty_frame_attempts: g.empty_attempts,
            near_end_attempts: 250,
            mid_track_attempts: mid_track_stall_attempts(&g.current_url),
            is_near_end,
            wall_elapsed_sec: wall,
            has_decoded_audio: g.frames_played > 0,
        });
        let remaining = if g.duration > 0.0 {
            g.duration - elapsed
        } else {
            f64::INFINITY
        };
        let action = stall_action_for_url(
            decide_stall_action(
                verdict,
                g.stall_resumes,
                remaining,
                !g.current_url.is_empty(),
            ),
            &g.current_url,
        );
        if action != StallAction::Continue {
            tracing::info!(
                action = ?action,
                empty_attempts = g.empty_attempts,
                elapsed = elapsed.round() as i64,
                "pcm stall"
            );
        }
        if action == StallAction::Resume {
            g.stall_resumes += 1;
            g.seek_offset = elapsed;
            g.frames_played = 0;
            g.empty_attempts = 0;
            g.pcm.clear();
            if let Some(tx) = g.child_kill_std.take() {
                let _ = tx.send(());
            }
            g.session += 1;
            g.ffmpeg_alive = true;
            g.resuming = true;
            return false;
        }
        if action == StallAction::End {
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
    if g.resuming {
        return false;
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
