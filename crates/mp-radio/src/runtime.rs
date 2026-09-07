// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use mp_config::{RadioConfig, WheelSlot};
use mp_music::{MusicStation, PlayerState};

use crate::bumpers::{build_from_sources, LiveBumperFactory};
use crate::director::{
    Boundary, BuiltBumper, BumperFactory, CueResult, DirectorHooks, RadioDirector,
};
use crate::seed::{program_station, seed_profile_tracks};

struct ConfigFactory {
    inner: LiveBumperFactory,
    config: Arc<RwLock<RadioConfig>>,
}

impl BumperFactory for ConfigFactory {
    async fn build(&self, slot: WheelSlot) -> Option<BuiltBumper> {
        let cfg = self.config.read().expect("radio cfg").clone();
        build_from_sources(&self.inner, &cfg, slot).await
    }
    async fn say(&self, text: &str) -> Option<BuiltBumper> {
        self.inner.say(text).await
    }
}

pub struct RadioRuntime {
    config: Arc<RwLock<RadioConfig>>,
    station: RwLock<Option<Arc<MusicStation>>>,
    director: RwLock<Option<Arc<RadioDirector<ArcFactory>>>>,
    factory: Arc<ConfigFactory>,
    dead_air_gen: AtomicU64,
}

#[derive(Clone)]
struct ArcFactory(Arc<ConfigFactory>);
impl BumperFactory for ArcFactory {
    async fn build(&self, slot: WheelSlot) -> Option<BuiltBumper> {
        self.0.build(slot).await
    }
    async fn say(&self, text: &str) -> Option<BuiltBumper> {
        self.0.say(text).await
    }
}

impl RadioRuntime {
    pub fn from_config(cfg: RadioConfig, station_name: String) -> Arc<Self> {
        let config = Arc::new(RwLock::new(cfg));
        let factory = Arc::new(ConfigFactory {
            inner: LiveBumperFactory::new(station_name),
            config: Arc::clone(&config),
        });
        Arc::new(Self {
            config,
            station: RwLock::new(None),
            director: RwLock::new(None),
            factory,
            dead_air_gen: AtomicU64::new(0),
        })
    }

    pub fn bind_station(self: &Arc<Self>, station: Arc<MusicStation>) {
        self.factory.inner.set_station(Arc::clone(&station));
        *self.station.write().expect("st") = Some(Arc::clone(&station));
        let cfg_fn = {
            let c = Arc::clone(&self.config);
            Arc::new(move || c.read().expect("radio cfg").clone())
                as Arc<dyn Fn() -> RadioConfig + Send + Sync>
        };
        let play_st = Arc::clone(&station);
        let bump_st = Arc::clone(&station);
        let prog_st = Arc::clone(&station);
        let stop_st = Arc::clone(&station);
        let pause_st = Arc::clone(&station);
        let state_st = Arc::clone(&station);
        let cfg_prog = Arc::clone(&self.config);
        let hooks = DirectorHooks {
            play_next: Arc::new(move || {
                play_st
                    .play_next()
                    .map(|s| format!("{} - {}", s.name, s.artist))
            }),
            play_bumper: Arc::new(move |b, floor| {
                bump_st.player.reset_failures();
                bump_st
                    .player
                    .play_with_floor(&b.path, 0.0, 0.0, Some(floor as f64));
            }),
            auto_program: Arc::new(move || {
                let cfg = cfg_prog.read().expect("radio cfg").clone();
                auto_program(&prog_st, &cfg)
            }),
            stop_empty: Arc::new(move || {
                stop_st.player.stop();
                stop_st.queue.lock().expect("q").clear();
            }),
            is_user_paused: Arc::new(move || pause_st.user_pause.lock().expect("p").is_some()),
            player_state: Arc::new(move || state_st.player.get_state()),
        };
        let director = RadioDirector::new(cfg_fn, ArcFactory(Arc::clone(&self.factory)), hooks);
        *self.director.write().expect("dir") = Some(Arc::new(director));
        self.spawn_dead_air();
    }

    fn spawn_dead_air(self: &Arc<Self>) {
        let generation = self.dead_air_gen.fetch_add(1, Ordering::SeqCst) + 1;
        let this = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                let secs = this
                    .config
                    .read()
                    .map(|c| c.dead_air_seconds.max(1))
                    .unwrap_or(25);
                tokio::time::sleep(Duration::from_secs(secs)).await;
                if this.dead_air_gen.load(Ordering::SeqCst) != generation {
                    break;
                }
                if !this.enabled() {
                    continue;
                }
                let idle = this.station.read().ok().and_then(|s| {
                    s.as_ref().map(|st| st.player.get_state() == PlayerState::Idle)
                });
                if idle != Some(true) {
                    continue;
                }
                if let Some(d) = this.director.read().ok().and_then(|g| g.clone()) {
                    d.fill_dead_air_now();
                }
            }
        });
    }

    pub fn config(&self) -> RadioConfig {
        self.config.read().expect("radio cfg").clone()
    }

    pub fn enabled(&self) -> bool {
        self.config.read().expect("radio cfg").enabled
    }

    pub fn apply(&self, cfg: RadioConfig) {
        *self.config.write().expect("radio cfg") = cfg;
    }

    pub fn set_tts(&self, url: String, voice: String) {
        self.factory.inner.set_tts(url, voice);
    }

    pub fn on_poll(&self, humans: u32) {
        if let Some(d) = self.director.read().expect("dir").as_ref() {
            d.on_poll(humans);
        }
    }

    pub fn note_human_activity(&self, clid: i32) {
        if let Some(d) = self.director.read().expect("dir").as_ref() {
            d.note_human_activity(clid);
        }
    }

    pub async fn on_track_boundary(&self) -> Boundary {
        let Some(d) = self.director.read().expect("dir").as_ref().cloned() else {
            if let Some(st) = self.station.read().expect("st").as_ref() {
                let song = st.play_next().map(|s| format!("{} - {}", s.name, s.artist));
                return Boundary::Advanced { song };
            }
            return Boundary::Advanced { song: None };
        };
        d.on_track_boundary().await
    }

    pub async fn cue_bumper(&self, topic: Option<String>) -> CueResult {
        let Some(d) = self.director.read().expect("dir").as_ref().cloned() else {
            return CueResult::Unavailable;
        };
        d.cue_bumper(topic).await
    }

    pub async fn cue_say(&self, text: &str) -> CueResult {
        let Some(d) = self.director.read().expect("dir").as_ref().cloned() else {
            return CueResult::Unavailable;
        };
        d.cue_say(text).await
    }

    pub fn skip_bumper(&self) -> &'static str {
        self.director
            .read()
            .expect("dir")
            .as_ref()
            .map(|d| d.skip_bumper())
            .unwrap_or("next")
    }

    pub fn status(&self) -> RadioStatusSnapshot {
        let cfg = self.config();
        let st = self
            .director
            .read()
            .expect("dir")
            .as_ref()
            .map(|d| d.status());
        RadioStatusSnapshot {
            enabled: cfg.enabled,
            active_profile: cfg.active_profile,
            profiles: cfg.profiles.keys().cloned().collect(),
            every_n_songs: cfg.every_n_songs,
            dead_air_seconds: cfg.dead_air_seconds,
            songs_until_bumper: st.as_ref().and_then(|s| s.songs_until_bumper),
            cue_pending: st.as_ref().map(|s| s.cue_pending).unwrap_or(false),
            skip_next_pending: st.as_ref().map(|s| s.skip_next_pending).unwrap_or(false),
            connected: self
                .station
                .read()
                .ok()
                .is_some_and(|s| s.as_ref().is_some_and(|st| st.is_connected())),
        }
    }

    pub fn set_enabled(&self, on: bool) {
        self.config.write().expect("cfg").enabled = on;
        if on {
            if let Some(st) = self.station.read().expect("st").as_ref() {
                if st.player.get_state() == PlayerState::Idle {
                    let cfg = self.config();
                    let _ = auto_program(st, &cfg);
                }
            }
        }
    }

    pub fn set_profile(&self, name: &str) -> Result<usize, String> {
        let mut cfg = self.config.write().expect("cfg");
        if !cfg.profiles.contains_key(name) {
            let names: Vec<_> = cfg.profiles.keys().cloned().collect();
            return Err(if names.is_empty() {
                format!("Unknown profile '{name}'.")
            } else {
                format!("Unknown profile '{name}'. Profiles: {}", names.join(", "))
            });
        }
        cfg.active_profile = name.to_string();
        let cfg_clone = cfg.clone();
        drop(cfg);
        Ok(self
            .station
            .read()
            .expect("st")
            .as_ref()
            .map(|st| {
                if auto_program(st, &cfg_clone) {
                    st.queue.lock().expect("q").size()
                } else {
                    0
                }
            })
            .unwrap_or(0))
    }

    pub fn program_active(&self) -> usize {
        let cfg = self.config();
        self.station
            .read()
            .expect("st")
            .as_ref()
            .map(|st| {
                if auto_program(st, &cfg) {
                    st.queue.lock().expect("q").size()
                } else {
                    0
                }
            })
            .unwrap_or(0)
    }

    pub fn profile_names(&self) -> Vec<String> {
        let mut n: Vec<_> = self.config().profiles.keys().cloned().collect();
        n.sort();
        n
    }
}

fn auto_program(station: &MusicStation, cfg: &RadioConfig) -> bool {
    let Some(profile) = cfg.profiles.get(&cfg.active_profile) else {
        return false;
    };
    let tracks = seed_profile_tracks(station, profile);
    program_station(station, tracks) > 0
}

#[derive(Debug, Clone)]
pub struct RadioStatusSnapshot {
    pub enabled: bool,
    pub active_profile: String,
    pub profiles: Vec<String>,
    pub every_n_songs: u32,
    pub dead_air_seconds: u64,
    pub songs_until_bumper: Option<u32>,
    pub cue_pending: bool,
    pub skip_next_pending: bool,
    pub connected: bool,
}
