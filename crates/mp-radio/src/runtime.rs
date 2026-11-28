// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use mp_config::{AutoDjRepeat, RadioConfig, RadioProfile, WheelSlot};
use mp_music::{MusicStation, PlayerState, Track};

use crate::bumpers::{LiveBumperFactory, PrewarmTally, build_from_sources};
use crate::director::{
    Boundary, BuiltBumper, BumperFactory, CueResult, DirectorHooks, RadioDirector,
};
use crate::seed::{LocalSeedPlan, program_station, seed_local_only, seed_with_plan};

type SeedHook = Arc<dyn Fn(&RadioProfile) -> LocalSeedPlan + Send + Sync>;
type AvoidHook = Arc<dyn Fn(&AutoDjRepeat) -> HashSet<String> + Send + Sync>;

/// Ids programmed on recent restocks. Play history covers restarts; this
/// covers the gap before those rows exist and a restock that fires first.
const RECENT_SEED_MEMORY: usize = 48;

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
    voice_floor: std::sync::Mutex<Option<Arc<dyn Fn(&str) + Send + Sync>>>,
    /// Installed after `bind_station`. Read on every auto-program, not captured once.
    local_seed: Arc<Mutex<Option<SeedHook>>>,
    avoid_hook: Arc<Mutex<Option<AvoidHook>>>,
    recent_seed: Arc<Mutex<VecDeque<String>>>,
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
            voice_floor: std::sync::Mutex::new(None),
            local_seed: Arc::new(Mutex::new(None)),
            avoid_hook: Arc::new(Mutex::new(None)),
            recent_seed: Arc::new(Mutex::new(VecDeque::new())),
        })
    }

    pub fn set_on_voice_floor(&self, hook: Arc<dyn Fn(&str) + Send + Sync>) {
        if let Some(director) = self.director.read().expect("dir").as_ref() {
            director.set_on_voice_floor(Arc::clone(&hook));
        }
        *self.voice_floor.lock().expect("floor") = Some(hook);
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
        let seed_slot = Arc::clone(&self.local_seed);
        let avoid_slot = Arc::clone(&self.avoid_hook);
        let recent = Arc::clone(&self.recent_seed);
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
                let plan = plan_from_slot(&seed_slot, &cfg);
                let avoid = avoid_ids(&avoid_slot, &recent, &cfg);
                auto_program(&prog_st, &cfg, &plan, &avoid, &recent)
            }),
            stop_empty: Arc::new(move || {
                stop_st.player.stop();
                stop_st.queue.lock().expect("q").clear();
            }),
            is_user_paused: Arc::new(move || pause_st.user_pause.lock().expect("p").is_some()),
            player_state: Arc::new(move || state_st.player.get_state()),
        };
        let director = RadioDirector::new(cfg_fn, ArcFactory(Arc::clone(&self.factory)), hooks);
        if let Some(hook) = self.voice_floor.lock().expect("floor").as_ref() {
            director.set_on_voice_floor(Arc::clone(hook));
        }
        *self.director.write().expect("dir") = Some(Arc::new(director));
        let hook_rt = Arc::downgrade(self);
        station.set_on_user_playback(Arc::new(move |duration_sec| {
            if let Some(rt) = hook_rt.upgrade() {
                rt.note_user_playback(duration_sec);
            }
        }));
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
                    s.as_ref()
                        .map(|st| st.player.get_state() == PlayerState::Idle)
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

    pub fn set_bumper_dir(&self, dir: std::path::PathBuf) {
        self.factory.inner.set_bumper_dir(dir);
    }

    pub fn set_bumper_cache_dir(&self, dir: std::path::PathBuf) {
        self.factory.inner.set_cache_dir(dir);
    }

    pub fn clear_bumper_cache(&self) -> usize {
        self.factory.inner.clear_cache()
    }

    pub async fn prewarm_bumpers(
        &self,
        include_doctrine: bool,
        hours_ahead: u32,
        lines: Vec<String>,
    ) -> PrewarmTally {
        let cfg = self.config();
        self.factory
            .inner
            .prewarm(&cfg, include_doctrine, hours_ahead, &lines)
            .await
    }

    pub fn set_local_seed(&self, hook: Arc<dyn Fn(&RadioProfile) -> LocalSeedPlan + Send + Sync>) {
        *self.local_seed.lock().expect("seed") = Some(hook);
    }

    /// Song ids the next auto-DJ pool should skip. Installed with the database
    /// so the 24h play-count cooldown survives a restart.
    pub fn set_avoid_hook(
        &self,
        hook: Arc<dyn Fn(&AutoDjRepeat) -> HashSet<String> + Send + Sync>,
    ) {
        *self.avoid_hook.lock().expect("avoid") = Some(hook);
    }

    pub fn set_retrieval(&self, retrieval: std::sync::Arc<mp_rag::RetrievalStore>) {
        self.factory.inner.set_retrieval(retrieval);
    }

    pub fn set_mempalace(&self, client: mp_rag::MemPalaceClient) {
        self.factory.inner.set_mempalace(client);
    }

    pub fn set_kg(&self, kg: std::sync::Arc<mp_rag::KgService>) {
        self.factory.inner.set_kg(kg);
    }

    pub fn set_llm(&self, llm: std::sync::Arc<mp_brain::BrainRuntime>) {
        self.factory.inner.set_llm(llm);
    }

    pub fn note_user_playback(&self, duration_sec: u32) {
        if let Some(d) = self.director.read().expect("dir").as_ref() {
            d.note_user_playback(duration_sec);
        }
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
                    let plan = plan_from_slot(&self.local_seed, &cfg);
                    let _ = self.program_now(st, &cfg, &plan);
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
        let plan = plan_from_slot(&self.local_seed, &cfg_clone);
        Ok(self
            .station
            .read()
            .expect("st")
            .as_ref()
            .map(|st| {
                if self.program_now(st, &cfg_clone, &plan) {
                    st.queue.lock().expect("q").size()
                } else {
                    0
                }
            })
            .unwrap_or(0))
    }

    pub fn program_active(&self) -> usize {
        let cfg = self.config();
        let plan = plan_from_slot(&self.local_seed, &cfg);
        self.station
            .read()
            .expect("st")
            .as_ref()
            .map(|st| {
                if self.program_now(st, &cfg, &plan) {
                    st.queue.lock().expect("q").size()
                } else {
                    0
                }
            })
            .unwrap_or(0)
    }

    fn program_now(&self, st: &MusicStation, cfg: &RadioConfig, plan: &LocalSeedPlan) -> bool {
        let avoid = avoid_ids(&self.avoid_hook, &self.recent_seed, cfg);
        auto_program(st, cfg, plan, &avoid, &self.recent_seed)
    }

    pub fn profile_names(&self) -> Vec<String> {
        let mut n: Vec<_> = self.config().profiles.keys().cloned().collect();
        n.sort();
        n
    }
}

fn plan_from_slot(slot: &Mutex<Option<SeedHook>>, cfg: &RadioConfig) -> LocalSeedPlan {
    let Some(profile) = cfg.profiles.get(&cfg.active_profile) else {
        return LocalSeedPlan::None;
    };
    let hook = slot.lock().expect("seed").clone();
    hook.as_ref()
        .map(|hook| hook(profile))
        .unwrap_or(LocalSeedPlan::None)
}

fn avoid_ids(
    slot: &Mutex<Option<AvoidHook>>,
    recent: &Mutex<VecDeque<String>>,
    cfg: &RadioConfig,
) -> HashSet<String> {
    let mut avoid = HashSet::new();
    if let Some(hook) = slot.lock().expect("avoid").clone() {
        avoid.extend(hook(&cfg.auto_dj_repeat));
    }
    avoid.extend(recent.lock().expect("recent").iter().cloned());
    avoid
}

fn note_programmed(recent: &Mutex<VecDeque<String>>, tracks: &[Track]) {
    let mut q = recent.lock().expect("recent");
    for track in tracks {
        if track.id.is_empty() {
            continue;
        }
        q.retain(|id| id != &track.id);
        q.push_back(track.id.clone());
    }
    while q.len() > RECENT_SEED_MEMORY {
        q.pop_front();
    }
}

fn auto_program(
    station: &MusicStation,
    cfg: &RadioConfig,
    plan: &LocalSeedPlan,
    avoid: &HashSet<String>,
    recent: &Mutex<VecDeque<String>>,
) -> bool {
    let Some(profile) = cfg.profiles.get(&cfg.active_profile) else {
        return false;
    };
    // YouTube metadata for every seed phrase can take about a minute. Start a
    // local song first when the channel is idle, then fold the external hits
    // into the queue without cutting that song. A request that lands during
    // the search owns the channel; do not clear the queue when it returns.
    let epoch = station.playback_epoch();
    let mut started_local = false;
    if station.player.get_state() == PlayerState::Idle {
        let local = seed_local_only(station, profile, plan, avoid);
        if station.playback_epoch() != epoch {
            tracing::info!("radio: auto-program dropped — user selected a track");
            return false;
        }
        if !local.is_empty() && program_station(station, local.clone()) > 0 {
            note_programmed(recent, &local);
            started_local = true;
        }
    }
    let tracks = seed_with_plan(station, profile, plan, avoid);
    if station.playback_epoch() != epoch {
        tracing::info!("radio: auto-program dropped — user selected a track");
        return started_local;
    }
    let sample: Vec<&str> = tracks.iter().take(4).map(|t| t.title.as_str()).collect();
    tracing::info!(
        queued = tracks.len(),
        avoided = avoid.len(),
        ?sample,
        "radio: seed pool built"
    );
    if program_station(station, tracks.clone()) == 0 {
        return started_local;
    }
    note_programmed(recent, &tracks);
    true
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
