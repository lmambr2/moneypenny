// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! RadioDirector — never put TTS between a user and skip. Disabled = play_next.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use mp_config::{BumperSource, RadioConfig, SlotKind, WheelSlot};
use mp_music::PlayerState;

use crate::clock::{is_within_quiet_hours, parse_hhmm, FormatClock};

const HOUR_MS: u64 = 3_600_000;
const ACTIVITY_TTL_MS: u64 = 3 * 60_000;

#[derive(Debug, Clone)]
pub struct BuiltBumper {
    pub path: String,
    pub label: String,
}

#[derive(Debug, Clone)]
pub enum Boundary {
    Bumper { label: String },
    Advanced { song: Option<String> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CueResult {
    Played,
    Cued,
    Unavailable,
}

pub trait BumperFactory: Send + Sync {
    fn build(
        &self,
        slot: WheelSlot,
    ) -> impl std::future::Future<Output = Option<BuiltBumper>> + Send;
    fn say(&self, text: &str) -> impl std::future::Future<Output = Option<BuiltBumper>> + Send;
}

pub struct DirectorHooks {
    pub play_next: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    pub play_bumper: Arc<dyn Fn(&BuiltBumper, u32) + Send + Sync>,
    pub auto_program: Arc<dyn Fn() -> bool + Send + Sync>,
    pub stop_empty: Arc<dyn Fn() + Send + Sync>,
    pub is_user_paused: Arc<dyn Fn() -> bool + Send + Sync>,
    pub player_state: Arc<dyn Fn() -> PlayerState + Send + Sync>,
}

struct Inner {
    pending_after_bumper: bool,
    last_bumper_at: u64,
    bumper_times: Vec<u64>,
    last_human_count: u32,
    activity: HashMap<i32, u64>,
    empty_since_ms: Option<u64>,
    empty_stopped: bool,
    cued: Option<Cued>,
    skip_next: bool,
    auto_program_after_bumper: bool,
    auto_program_in_flight: bool,
    last_played: Option<BuiltBumper>,
    clock: Option<FormatClock>,
    clock_sig: String,
}

enum Cued {
    Slot(WheelSlot),
    Say(String),
}

pub struct RadioDirector<F> {
    config: Arc<dyn Fn() -> RadioConfig + Send + Sync>,
    factory: F,
    hooks: DirectorHooks,
    inner: Mutex<Inner>,
    dead_air_gen: AtomicU64,
    now_ms: Option<Arc<dyn Fn() -> u64 + Send + Sync>>,
}

impl<F: BumperFactory> RadioDirector<F> {
    pub fn new(
        config: Arc<dyn Fn() -> RadioConfig + Send + Sync>,
        factory: F,
        hooks: DirectorHooks,
    ) -> Self {
        Self {
            config,
            factory,
            hooks,
            inner: Mutex::new(Inner {
                pending_after_bumper: false,
                last_bumper_at: 0,
                bumper_times: Vec::new(),
                last_human_count: 0,
                activity: HashMap::new(),
                empty_since_ms: None,
                empty_stopped: false,
                cued: None,
                skip_next: false,
                auto_program_after_bumper: false,
                auto_program_in_flight: false,
                last_played: None,
                clock: None,
                clock_sig: String::new(),
            }),
            dead_air_gen: AtomicU64::new(0),
            now_ms: None,
        }
    }

    pub fn with_now(mut self, now: Arc<dyn Fn() -> u64 + Send + Sync>) -> Self {
        self.now_ms = Some(now);
        self
    }

    fn now(&self) -> u64 {
        if let Some(n) = &self.now_ms {
            return n();
        }
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn cfg(&self) -> RadioConfig {
        (self.config)()
    }

    pub fn on_poll(&self, human_count: u32) {
        let mut g = self.inner.lock().expect("radio");
        g.last_human_count = human_count;
        drop(g);
        let cfg = self.cfg();
        if !cfg.enabled {
            return;
        }
        if self.enforce_alone_stop(&cfg) {
            return;
        }
        if (self.hooks.is_user_paused)() {
            return;
        }
        if (self.hooks.player_state)() != PlayerState::Idle {
            return;
        }
        if self.inner.lock().expect("radio").auto_program_in_flight {
            return;
        }
        if self.effective_human_count() >= cfg.min_present_to_broadcast {
            self.arm_dead_air();
        }
    }

    pub fn note_human_activity(&self, clid: i32) {
        if clid <= 0 {
            return;
        }
        let now = self.now();
        self.inner.lock().expect("radio").activity.insert(clid, now);
    }

    pub fn effective_human_count(&self) -> u32 {
        let now = self.now();
        let mut g = self.inner.lock().expect("radio");
        g.activity.retain(|_, t| now.saturating_sub(*t) <= ACTIVITY_TTL_MS);
        g.last_human_count.max(g.activity.len() as u32)
    }

    pub fn status(&self) -> RadioStatus {
        let cfg = self.cfg();
        let g = self.inner.lock().expect("radio");
        RadioStatus {
            songs_until_bumper: if cfg.enabled {
                self.clock_songs_until(&g, &cfg)
            } else {
                None
            },
            cue_pending: g.cued.is_some(),
            skip_next_pending: g.skip_next,
        }
    }

    fn clock_songs_until(&self, g: &Inner, cfg: &RadioConfig) -> Option<u32> {
        match &g.clock {
            Some(c) => c.songs_until_non_song(),
            None => self.build_clock(cfg).songs_until_non_song(),
        }
    }

    fn build_clock(&self, cfg: &RadioConfig) -> FormatClock {
        FormatClock::for_config(cfg.every_n_songs, cfg.clock.as_ref(), cfg.sources.clone())
    }

    pub async fn on_track_boundary(&self) -> Boundary {
        let cfg = self.cfg();
        if !cfg.enabled {
            let song = (self.hooks.play_next)();
            return Boundary::Advanced { song };
        }
        if self.enforce_alone_stop(&cfg) {
            return Boundary::Advanced { song: None };
        }
        {
            let mut g = self.inner.lock().expect("radio");
            if g.pending_after_bumper {
                g.pending_after_bumper = false;
                let restock = g.auto_program_after_bumper;
                g.auto_program_after_bumper = false;
                drop(g);
                if restock && self.try_auto_program() {
                    return Boundary::Advanced { song: None };
                }
                let song = (self.hooks.play_next)();
                if song.is_none() {
                    self.arm_dead_air();
                }
                return Boundary::Advanced { song };
            }
        }
        let cued = {
            let g = self.inner.lock().expect("radio");
            g.cued.is_some()
        };
        if cued && self.fire_cued(&cfg).await {
            return Boundary::Bumper {
                label: self
                    .inner
                    .lock()
                    .expect("radio")
                    .last_played
                    .as_ref()
                    .map(|b| b.label.clone())
                    .unwrap_or_default(),
            };
        }
        let slot = {
            let mut g = self.inner.lock().expect("radio");
            let sig = format!("{:?}:{}", cfg.every_n_songs, cfg.sources.len());
            if g.clock.is_none() || g.clock_sig != sig {
                g.clock = Some(self.build_clock(&cfg));
                g.clock_sig = sig;
            }
            g.clock.as_mut().unwrap().next_slot()
        };
        if slot.slot == SlotKind::Song {
            return self.advance();
        }
        {
            let mut g = self.inner.lock().expect("radio");
            if g.skip_next {
                g.skip_next = false;
                drop(g);
                tracing::info!("radio: bumper slot dropped (!radio skip)");
                return self.advance();
            }
        }
        if !self.can_broadcast(&cfg) {
            tracing::info!("radio: bumper slot skipped — broadcast gate");
            return self.advance();
        }
        if self.try_bumper(&cfg, slot).await {
            return Boundary::Bumper {
                label: self
                    .inner
                    .lock()
                    .expect("radio")
                    .last_played
                    .as_ref()
                    .map(|b| b.label.clone())
                    .unwrap_or_default(),
            };
        }
        tracing::info!("radio: bumper slot skipped — no source produced audio");
        self.advance()
    }

    pub async fn cue_bumper(&self, topic: Option<String>) -> CueResult {
        let cfg = self.cfg();
        if !cfg.enabled {
            return CueResult::Unavailable;
        }
        let sources = if topic.is_some() {
            vec![BumperSource::Doctrine]
        } else {
            cfg.sources.clone()
        };
        self.inner.lock().expect("radio").cued = Some(Cued::Slot(WheelSlot {
            slot: SlotKind::Bumper,
            sources,
            topic,
        }));
        self.maybe_fire_now(&cfg).await
    }

    pub async fn cue_say(&self, text: &str) -> CueResult {
        let cfg = self.cfg();
        if !cfg.enabled {
            return CueResult::Unavailable;
        }
        self.inner.lock().expect("radio").cued = Some(Cued::Say(text.to_string()));
        self.maybe_fire_now(&cfg).await
    }

    pub fn skip_bumper(&self) -> &'static str {
        let mut g = self.inner.lock().expect("radio");
        if g.cued.take().is_some() {
            "cue"
        } else {
            g.skip_next = true;
            "next"
        }
    }

    async fn maybe_fire_now(&self, cfg: &RadioConfig) -> CueResult {
        if (self.hooks.player_state)() != PlayerState::Idle {
            return CueResult::Cued;
        }
        self.cancel_dead_air();
        if self.fire_cued(cfg).await {
            CueResult::Played
        } else {
            CueResult::Unavailable
        }
    }

    async fn fire_cued(&self, cfg: &RadioConfig) -> bool {
        let cue = {
            let mut g = self.inner.lock().expect("radio");
            g.cued.take()
        };
        let Some(cue) = cue else {
            return false;
        };
        let bumper = match cue {
            Cued::Say(t) => self.factory.say(&t).await,
            Cued::Slot(slot) => self.factory.build(self.resolve_sources(cfg, slot)).await,
        };
        let Some(bumper) = bumper else {
            return false;
        };
        self.record_and_play(cfg, bumper);
        true
    }

    async fn try_bumper(&self, cfg: &RadioConfig, slot: WheelSlot) -> bool {
        let slot = self.resolve_sources(cfg, slot);
        let Some(bumper) = self.factory.build(slot).await else {
            return false;
        };
        self.record_and_play(cfg, bumper);
        true
    }

    fn record_and_play(&self, cfg: &RadioConfig, bumper: BuiltBumper) {
        let now = self.now();
        {
            let mut g = self.inner.lock().expect("radio");
            g.last_bumper_at = now;
            g.bumper_times.push(now);
            g.pending_after_bumper = true;
            g.last_played = Some(bumper.clone());
            prune_hourly(&mut g.bumper_times, now);
        }
        self.cancel_dead_air();
        (self.hooks.play_bumper)(&bumper, cfg.speech_volume_pct);
        tracing::info!(path = %bumper.path, label = %bumper.label, "radio: bumper injected");
    }

    fn resolve_sources(&self, cfg: &RadioConfig, slot: WheelSlot) -> WheelSlot {
        if !slot.sources.is_empty() {
            return slot;
        }
        if slot.slot == SlotKind::StationId {
            return WheelSlot {
                sources: vec![BumperSource::StationId],
                ..slot
            };
        }
        WheelSlot {
            sources: cfg.sources.clone(),
            ..slot
        }
    }

    fn advance(&self) -> Boundary {
        let cfg = self.cfg();
        if self.enforce_alone_stop(&cfg) {
            return Boundary::Advanced { song: None };
        }
        let song = (self.hooks.play_next)();
        if song.is_some() {
            self.cancel_dead_air();
        } else {
            let humans = self.inner.lock().expect("radio").last_human_count;
            if humans >= 1 || cfg.empty_channel_stop_seconds < 0 {
                self.arm_dead_air();
            }
        }
        Boundary::Advanced { song }
    }

    fn can_broadcast(&self, cfg: &RadioConfig) -> bool {
        if self.effective_human_count() < cfg.min_present_to_broadcast {
            return false;
        }
        let now = self.now();
        let minutes = local_minutes_now();
        let windows: Vec<(u32, u32)> = cfg
            .quiet_hours
            .iter()
            .filter_map(|w| Some((parse_hhmm(&w.from)?, parse_hhmm(&w.to)?)))
            .collect();
        if is_within_quiet_hours(minutes, &windows) {
            return false;
        }
        let g = self.inner.lock().expect("radio");
        if now.saturating_sub(g.last_bumper_at) < cfg.cooldown_seconds * 1000 {
            return false;
        }
        let mut times = g.bumper_times.clone();
        drop(g);
        prune_hourly(&mut times, now);
        times.len() < cfg.max_bumpers_per_hour as usize
    }

    fn enforce_alone_stop(&self, cfg: &RadioConfig) -> bool {
        let threshold = cfg.empty_channel_stop_seconds;
        let humans = self.inner.lock().expect("radio").last_human_count;
        if humans >= 1 {
            let mut g = self.inner.lock().expect("radio");
            let was = g.empty_stopped;
            g.empty_since_ms = None;
            g.empty_stopped = false;
            drop(g);
            if was && threshold >= 0 {
                let _ = self.try_auto_program();
            }
            return false;
        }
        if threshold < 0 {
            let mut g = self.inner.lock().expect("radio");
            g.empty_since_ms = None;
            g.empty_stopped = false;
            return false;
        }
        let now = self.now();
        let mut g = self.inner.lock().expect("radio");
        if g.empty_since_ms.is_none() {
            g.empty_since_ms = Some(now);
        }
        let empty_sec = (now.saturating_sub(g.empty_since_ms.unwrap_or(now))) / 1000;
        if empty_sec < threshold as u64 {
            return false;
        }
        if !g.empty_stopped {
            g.empty_stopped = true;
            drop(g);
            self.cancel_dead_air();
            (self.hooks.stop_empty)();
            tracing::info!(empty_sec, threshold, "radio: stopped — alone in channel");
        }
        true
    }

    fn try_auto_program(&self) -> bool {
        if (self.hooks.is_user_paused)() {
            return false;
        }
        let cfg = self.cfg();
        let humans = self.inner.lock().expect("radio").last_human_count;
        if cfg.empty_channel_stop_seconds >= 0 && humans < 1 {
            return false;
        }
        {
            let mut g = self.inner.lock().expect("radio");
            if g.auto_program_in_flight {
                return false;
            }
            g.auto_program_in_flight = true;
        }
        self.cancel_dead_air();
        let ok = (self.hooks.auto_program)();
        self.inner.lock().expect("radio").auto_program_in_flight = false;
        if ok {
            self.cancel_dead_air();
            tracing::info!("radio: auto-programmed from the active profile");
        } else if (self.hooks.player_state)() == PlayerState::Idle {
            self.arm_dead_air();
        }
        ok
    }

    fn arm_dead_air(&self) {
        let cfg = self.cfg();
        if !cfg.enabled || (self.hooks.is_user_paused)() {
            return;
        }
        if self.inner.lock().expect("radio").auto_program_in_flight {
            return;
        }
        let _generation = self.dead_air_gen.fetch_add(1, Ordering::SeqCst) + 1;
        let _secs = cfg.dead_air_seconds.max(1);
        // Production runtime arms a tokio sleep in RadioRuntime.
    }

    fn cancel_dead_air(&self) {
        self.dead_air_gen.fetch_add(1, Ordering::SeqCst);
    }

    pub fn dead_air_generation(&self) -> u64 {
        self.dead_air_gen.load(Ordering::SeqCst)
    }

    pub fn fill_dead_air_now(&self) {
        let cfg = self.cfg();
        if !cfg.enabled {
            return;
        }
        if (self.hooks.is_user_paused)() {
            return;
        }
        if (self.hooks.player_state)() != PlayerState::Idle {
            return;
        }
        if self.enforce_alone_stop(&cfg) {
            return;
        }
        let humans = self.inner.lock().expect("radio").last_human_count;
        let allow = cfg.empty_channel_stop_seconds < 0 || humans >= 1;
        if allow && self.try_auto_program() {
            return;
        }
        if allow {
            self.arm_dead_air();
        }
    }

    pub fn last_played(&self) -> Option<BuiltBumper> {
        self.inner.lock().expect("radio").last_played.clone()
    }
}

#[derive(Debug, Clone)]
pub struct RadioStatus {
    pub songs_until_bumper: Option<u32>,
    pub cue_pending: bool,
    pub skip_next_pending: bool,
}

fn prune_hourly(times: &mut Vec<u64>, now: u64) {
    let cutoff = now.saturating_sub(HOUR_MS);
    times.retain(|t| *t >= cutoff);
}

fn local_minutes_now() -> u32 {
    let out = std::process::Command::new("date")
        .arg("+%H:%M")
        .output()
        .ok();
    if let Some(o) = out {
        if let Ok(s) = String::from_utf8(o.stdout) {
            if let Some(m) = parse_hhmm(s.trim()) {
                return m;
            }
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use mp_config::RadioConfig;
    use std::sync::atomic::AtomicBool;

    struct Scripted {
        bumper: Mutex<Option<BuiltBumper>>,
    }
    impl BumperFactory for Scripted {
        async fn build(&self, _slot: WheelSlot) -> Option<BuiltBumper> {
            self.bumper.lock().unwrap().clone()
        }
        async fn say(&self, text: &str) -> Option<BuiltBumper> {
            Some(BuiltBumper {
                path: format!("/tmp/say-{}.wav", text.len()),
                label: "say".into(),
            })
        }
    }

    fn harness(enabled: bool, every_n: u32) -> (
        RadioDirector<Scripted>,
        Arc<Mutex<Vec<String>>>,
        Arc<AtomicBool>,
        Arc<Mutex<PlayerState>>,
        Arc<Mutex<RadioConfig>>,
    ) {
        let plays = Arc::new(Mutex::new(Vec::new()));
        let advanced = Arc::new(AtomicBool::new(true));
        let state = Arc::new(Mutex::new(PlayerState::Playing));
        let cfg = Arc::new(Mutex::new(RadioConfig {
            enabled,
            every_n_songs: every_n,
            min_present_to_broadcast: 1,
            cooldown_seconds: 0,
            ..RadioConfig::default()
        }));
        let bumper = Mutex::new(Some(BuiltBumper {
            path: "/bumpers/id.mp3".into(),
            label: "id".into(),
        }));
        let plays_c = Arc::clone(&plays);
        let advanced_c = Arc::clone(&advanced);
        let state_c = Arc::clone(&state);
        let cfg_c = Arc::clone(&cfg);
        let director = RadioDirector::new(
            Arc::new(move || cfg_c.lock().unwrap().clone()),
            Scripted { bumper },
            DirectorHooks {
                play_next: Arc::new(move || {
                    if advanced_c.load(Ordering::SeqCst) {
                        Some("next".into())
                    } else {
                        None
                    }
                }),
                play_bumper: Arc::new(move |b, _| {
                    plays_c.lock().unwrap().push(b.path.clone());
                }),
                auto_program: Arc::new(|| false),
                stop_empty: Arc::new(|| {}),
                is_user_paused: Arc::new(|| false),
                player_state: Arc::new(move || *state_c.lock().unwrap()),
            },
        );
        (director, plays, advanced, state, cfg)
    }

    #[tokio::test]
    async fn disabled_just_advances() {
        let (d, plays, ..) = harness(false, 2);
        d.on_track_boundary().await;
        d.on_track_boundary().await;
        assert!(plays.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn bumper_after_n_songs_then_guard() {
        let (d, plays, ..) = harness(true, 2);
        d.on_poll(1);
        d.on_track_boundary().await;
        d.on_track_boundary().await;
        assert!(plays.lock().unwrap().is_empty());
        d.on_track_boundary().await;
        assert_eq!(plays.lock().unwrap().len(), 1);
        d.on_track_boundary().await;
        assert_eq!(plays.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn unready_bumper_falls_through_to_music() {
        // Unready bumper: Scripted returns None → music first.
        let plays = Arc::new(Mutex::new(Vec::new()));
        let state = Arc::new(Mutex::new(PlayerState::Playing));
        let cfg = Arc::new(Mutex::new(RadioConfig {
            enabled: true,
            every_n_songs: 1,
            min_present_to_broadcast: 1,
            cooldown_seconds: 0,
            ..RadioConfig::default()
        }));
        let cfg_c = Arc::clone(&cfg);
        let plays_c = Arc::clone(&plays);
        let state_c = Arc::clone(&state);
        let d = RadioDirector::new(
            Arc::new(move || cfg_c.lock().unwrap().clone()),
            Scripted {
                bumper: Mutex::new(None),
            },
            DirectorHooks {
                play_next: Arc::new(|| Some("n".into())),
                play_bumper: Arc::new(move |b, _| {
                    plays_c.lock().unwrap().push(b.path.clone());
                }),
                auto_program: Arc::new(|| false),
                stop_empty: Arc::new(|| {}),
                is_user_paused: Arc::new(|| false),
                player_state: Arc::new(move || *state_c.lock().unwrap()),
            },
        );
        d.on_poll(1);
        d.on_track_boundary().await; // song
        d.on_track_boundary().await; // bumper slot, unready
        assert!(plays.lock().unwrap().is_empty());
    }
}
