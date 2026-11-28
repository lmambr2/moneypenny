// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use mp_audio::{MIN_PCM_BOOST_PEAK, STT_TARGET_PEAK, normalize_pcm_for_stt, pcm_peak};
use mp_config::{MIN_LISTEN_WINDOW_MS, VoiceConfig, effective_duck_volume};
use tokio::sync::mpsc;

use crate::duplex::{self, Inbound};
use crate::duplex_pump::{DuplexPcmPump, downsample_48k_to_24k_mono};
use crate::duplex_text::accept_user_asr;
use crate::duplex_watch::{DuplexHealth, DuplexWatch, WatchAction, WatchState};
use crate::floor::{VoiceFloor, VoiceFloorController};
use crate::pipeline::{TranscriptOpts, VoicePipeline, VoiceTurnResult};
use crate::probe::{probe_http_stt, probe_http_tts};
use crate::stt::HttpSttClient;
use crate::tts::HttpTtsClient;
use crate::vad::SilenceSegmenter;
use crate::{DuplexStatus, Utterance, VoiceStatus};

/// TeamSpeak music codec — never feed this to STT.
const CODEC_OPUS_MUSIC: u8 = 5;

pub struct IngestResult {
    pub utterances: Vec<Utterance>,
    pub speech: bool,
    pub raw_peak: u32,
}

struct Capture {
    decoder: Option<mp_audio::NativeOpus>,
    segmenters: HashMap<i32, SilenceSegmenter>,
    seen: HashSet<i32>,
    energy_threshold: f64,
}

pub struct VoiceRuntime {
    config: RwLock<VoiceConfig>,
    aliases: RwLock<HashMap<String, String>>,
    active: AtomicBool,
    inbound: AtomicU64,
    pipeline: Mutex<VoicePipeline>,
    capture: Mutex<Capture>,
    floor: Mutex<VoiceFloorController>,
    watch: Mutex<DuplexWatch>,
    duplex_health: Mutex<Option<DuplexHealth>>,
    talker_tx: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    send_opus: Mutex<Option<Arc<dyn Fn(Vec<u8>) + Send + Sync>>>,
    pump: Mutex<DuplexPcmPump>,
    encoder: Mutex<Option<mp_audio::NativeOpus>>,
    duplex_started: AtomicBool,
}

impl VoiceRuntime {
    pub fn from_config(cfg: VoiceConfig, aliases: HashMap<String, String>) -> Arc<Self> {
        let mut cfg = cfg;
        cfg.listen_window_ms = cfg.listen_window_ms.max(MIN_LISTEN_WINDOW_MS);
        let pipeline = VoicePipeline::from_config(&cfg, aliases.clone());
        let rt = Arc::new(Self {
            config: RwLock::new(cfg.clone()),
            aliases: RwLock::new(aliases),
            active: AtomicBool::new(false),
            inbound: AtomicU64::new(0),
            pipeline: Mutex::new(pipeline),
            capture: Mutex::new(Capture {
                decoder: None,
                segmenters: HashMap::new(),
                seen: HashSet::new(),
                energy_threshold: cfg.energy_threshold,
            }),
            floor: Mutex::new(VoiceFloorController::default()),
            watch: Mutex::new(DuplexWatch::default()),
            duplex_health: Mutex::new(None),
            talker_tx: Mutex::new(None),
            send_opus: Mutex::new(None),
            pump: Mutex::new(DuplexPcmPump::default()),
            encoder: Mutex::new(open_talker_encoder()),
            duplex_started: AtomicBool::new(false),
        });
        rt.reconfigure();
        rt
    }

    pub async fn synthesize_sentence(&self, sentence: &str) -> Option<Vec<u8>> {
        let cfg = self.config();
        if cfg.tts_url.trim().is_empty() || sentence.trim().is_empty() {
            return None;
        }
        let tts = HttpTtsClient::new(&cfg.tts_url, &cfg.tts_voice);
        tts.synthesize(sentence)
            .await
            .ok()
            .map(|(audio, _)| audio)
            .filter(|a| !a.is_empty())
    }

    /// One wav for a finished reply. Used when the token stream produced no sentences.
    pub async fn synthesize_reply(&self, reply: &str) -> Option<Vec<u8>> {
        use crate::speak::tts_speak_chunks;
        use crate::watchword::{should_speak_voice_reply, voice_spoken_line};
        let cfg = self.config();
        if cfg.tts_url.trim().is_empty() {
            return None;
        }
        let spoken = voice_spoken_line(Some(reply));
        let chunks = spoken
            .map(|s| vec![s])
            .unwrap_or_else(|| tts_speak_chunks(reply));
        let tts = HttpTtsClient::new(&cfg.tts_url, &cfg.tts_voice);
        let mut audio_all = Vec::new();
        for tts_text in chunks {
            if tts_text.is_empty() || !should_speak_voice_reply(&tts_text, 900) {
                continue;
            }
            match tts.synthesize(&tts_text).await {
                Ok((audio, _)) => audio_all.extend(audio),
                Err(e) => {
                    tracing::warn!(error = %e, "Voice: TTS failed");
                    break;
                }
            }
        }
        if audio_all.is_empty() {
            None
        } else {
            Some(audio_all)
        }
    }

    pub fn config(&self) -> VoiceConfig {
        self.config.read().expect("voice cfg").clone()
    }

    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    pub fn inbound_packets(&self) -> u64 {
        self.inbound.load(Ordering::SeqCst)
    }

    pub fn duck_volume(&self) -> u32 {
        let c = self.config();
        effective_duck_volume(c.karaoke_mode, c.duck_music_volume)
    }

    pub fn apply(&self, cfg: VoiceConfig) {
        let mut cfg = cfg;
        cfg.listen_window_ms = cfg.listen_window_ms.max(MIN_LISTEN_WINDOW_MS);
        let prev = self.config();
        let rebuild = needs_pipeline_rebuild(&prev, &cfg);
        *self.config.write().expect("voice cfg") = cfg;
        if rebuild {
            self.reconfigure();
        }
    }

    /// Live karaoke on/off — does not restart STT/TTS.
    pub fn set_karaoke_mode(&self, on: bool) {
        self.config.write().expect("voice cfg").karaoke_mode = on;
    }

    pub fn karaoke_mode(&self) -> bool {
        self.config().karaoke_mode
    }

    pub fn set_aliases(&self, aliases: HashMap<String, String>) {
        *self.aliases.write().expect("aliases") = aliases;
        self.reconfigure();
    }

    fn reconfigure(&self) {
        let cfg = self.config();
        let aliases = self.aliases.read().expect("aliases").clone();
        let active = cfg.enabled && !cfg.stt_url.trim().is_empty();
        self.active.store(active, Ordering::SeqCst);
        *self.pipeline.lock().expect("pipe") = VoicePipeline::from_config(&cfg, aliases);
        let mut cap = self.capture.lock().expect("cap");
        cap.segmenters.clear();
        cap.seen.clear();
        cap.energy_threshold = if cfg.energy_threshold > 0.0 {
            cfg.energy_threshold
        } else {
            200.0
        };
        cap.decoder = if active {
            match mp_audio::NativeOpus::new(48_000, 1) {
                Ok(d) => Some(d),
                Err(e) => {
                    tracing::warn!(error = %e, "Voice: opus decoder unavailable");
                    None
                }
            }
        } else {
            None
        };
        if cfg.enabled && cfg.stt_url.trim().is_empty() {
            tracing::warn!("Voice enabled but no sttUrl configured — voice loop inactive");
        } else if active {
            if cfg.vad_backend.eq_ignore_ascii_case("silero") {
                tracing::info!(
                    "Voice: silero VAD requested — using energy end-pointer (ONNX stays in the Node sidecar path; STT keyword is KWS)"
                );
            }
            tracing::info!(
                stt = %cfg.stt_url,
                tts = %cfg.tts_url,
                watchword = %cfg.watchword,
                energy = cfg.energy_threshold,
                vad = %cfg.vad_backend,
                "Voice pipeline enabled"
            );
        } else {
            tracing::info!("Voice pipeline disabled");
        }
    }

    pub fn any_armed(&self) -> bool {
        self.pipeline.lock().expect("pipe").any_armed()
    }

    pub fn on_client_leave(&self, client_id: i32) {
        let mut cap = self.capture.lock().expect("cap");
        cap.segmenters.remove(&client_id);
        cap.seen.remove(&client_id);
        drop(cap);
        self.pipeline.lock().expect("pipe").disarm(client_id);
    }

    /// Decode inbound Opus, energy-VAD, maybe complete an utterance.
    pub fn ingest_opus(
        &self,
        client_id: i32,
        opus: &[u8],
        self_id: i32,
        codec: u8,
    ) -> Option<IngestResult> {
        if !self.is_active() {
            return None;
        }
        if self_id > 0 && client_id == self_id {
            return None;
        }
        if codec == CODEC_OPUS_MUSIC {
            return None;
        }
        self.inbound.fetch_add(1, Ordering::SeqCst);

        let mut cap = self.capture.lock().expect("cap");
        if !cap.seen.contains(&client_id) {
            cap.seen.insert(client_id);
            tracing::info!(
                client_id,
                codec,
                bytes = opus.len(),
                "Voice: first inbound packet"
            );
        }
        let Some(dec) = cap.decoder.as_mut() else {
            return None;
        };
        let decoded = dec.decode_voice(opus).ok()?;
        if !decoded.ok {
            return None;
        }
        let pcm = decoded.pcm;
        self.forward_user_pcm(&pcm);
        let raw_peak = pcm_peak(&pcm).unwrap_or(0);
        let speech = raw_peak >= MIN_PCM_BOOST_PEAK;
        let pcm_stt = normalize_pcm_for_stt(&pcm, STT_TARGET_PEAK, 120.0, MIN_PCM_BOOST_PEAK)
            .unwrap_or_else(|_| pcm.clone());

        let threshold = cap.energy_threshold;
        let now = Instant::now();
        let mut utterances = Vec::new();
        // Another speaker's pause has to close even while this packet is in flight.
        // Collect first: polling and pushing the same map entry alias.
        let stale: Vec<(i32, Vec<u8>)> = cap
            .segmenters
            .iter_mut()
            .filter(|(id, _)| **id != client_id)
            .filter_map(|(id, seg)| seg.poll_idle(now).map(|pcm| (*id, pcm)))
            .collect();
        for (id, pcm) in stale {
            utterances.push(utterance_from(id, pcm));
        }
        let seg = cap
            .segmenters
            .entry(client_id)
            .or_insert_with(|| SilenceSegmenter::for_teamspeak(threshold));
        for pcm in seg.push(&pcm_stt) {
            utterances.push(utterance_from(client_id, pcm));
        }
        drop(cap);
        Some(IngestResult {
            utterances,
            speech,
            raw_peak,
        })
    }

    /// Close turns that have been quiet for the hangover. TeamSpeak does not
    /// send silence, so this has to run on a timer.
    pub fn poll_idle_utterances(&self) -> Vec<Utterance> {
        if !self.is_active() {
            return Vec::new();
        }
        let now = Instant::now();
        let mut cap = self.capture.lock().expect("cap");
        let mut out = Vec::new();
        for (client_id, seg) in cap.segmenters.iter_mut() {
            if let Some(pcm) = seg.poll_idle(now) {
                out.push(utterance_from(*client_id, pcm));
            }
        }
        out
    }

    pub async fn transcribe(&self, u: &Utterance) -> String {
        self.transcribe_ex(u).await.0
    }

    pub async fn transcribe_ex(&self, u: &Utterance) -> (String, Option<String>) {
        let url = self.config().stt_url;
        if url.trim().is_empty() {
            return (String::new(), None);
        }
        let profile = self.stt_profile();
        HttpSttClient::new(url).transcribe_profile(u, profile).await
    }

    fn stt_profile(&self) -> Option<&'static str> {
        if self.config().mode != "duplex" {
            return None;
        }
        match self.watch.lock().expect("watch").state {
            WatchState::FallbackCascaded | WatchState::FallbackRtf => Some("cascaded"),
            _ => Some("wake"),
        }
    }

    /// True while the Talker pump owns the 20 ms slot.
    pub fn blocks_player_voice(&self) -> bool {
        !self.floor.lock().expect("floor").player_sends()
    }

    pub fn set_floor(&self, name: &str) {
        self.floor.lock().expect("floor").set_named(name);
    }

    pub fn set_opus_sender(&self, send: Arc<dyn Fn(Vec<u8>) + Send + Sync>) {
        *self.send_opus.lock().expect("opus") = Some(send);
    }

    pub fn note_watchword(&self) {
        if self.config().mode != "duplex" {
            return;
        }
        let loaded = self
            .duplex_health
            .lock()
            .expect("health")
            .as_ref()
            .and_then(|h| h.loaded)
            .unwrap_or(false);
        let actions = self.watch.lock().expect("watch").on_watchword(loaded);
        self.spawn_actions(actions);
    }

    /// Whisper final only. Mute the Talker and take the Piper floor.
    pub fn note_user_final(&self, text: &str) {
        if self.config().mode != "duplex" {
            return;
        }
        if self.watch.lock().expect("watch").state != WatchState::ArmedDuplex {
            return;
        }
        if accept_user_asr(text).is_empty() {
            return;
        }
        self.floor.lock().expect("floor").set(VoiceFloor::PiperAck);
        self.spawn_actions(vec![WatchAction::MuteOut]);
    }

    pub fn on_piper_finished(&self) {
        let mut floor = self.floor.lock().expect("floor");
        if floor.floor == VoiceFloor::PiperAck {
            floor.set(VoiceFloor::Music);
        }
    }

    pub fn on_channel_humans(&self, humans: u32) {
        if humans > 0 || self.config().mode != "duplex" {
            return;
        }
        let loaded = self
            .duplex_health
            .lock()
            .expect("health")
            .as_ref()
            .and_then(|h| h.loaded)
            .unwrap_or(false);
        let actions = self.watch.lock().expect("watch").on_empty_channel(loaded);
        self.spawn_actions(actions);
    }

    /// Health poll plus the PCM socket. No-op without a tokio runtime.
    pub fn spawn_supervisor(self: &Arc<Self>, set_resident: Arc<dyn Fn(bool) + Send + Sync>) {
        if self.duplex_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            self.duplex_started.store(false, Ordering::SeqCst);
            return;
        };
        let this = Arc::clone(self);
        handle.spawn(async move {
            let http = reqwest::Client::new();
            let mut tick = tokio::time::interval(Duration::from_secs(2));
            let mut saw_duplex = false;
            loop {
                tick.tick().await;
                this.poll_duplex(&http, &set_resident, &mut saw_duplex)
                    .await;
            }
        });
    }

    async fn poll_duplex(
        self: &Arc<Self>,
        http: &reqwest::Client,
        set_resident: &Arc<dyn Fn(bool) + Send + Sync>,
        saw_duplex: &mut bool,
    ) {
        let cfg = self.config();
        if cfg.mode != "duplex" || cfg.duplex_url.trim().is_empty() {
            *saw_duplex = false;
            set_resident(false);
            *self.duplex_health.lock().expect("health") = None;
            *self.talker_tx.lock().expect("tx") = None;
            return;
        }
        if !*saw_duplex {
            self.watch.lock().expect("watch").on_operator_set_duplex();
            *saw_duplex = true;
            self.ensure_pcm_link(&cfg.duplex_url);
        }
        if self.watch.lock().expect("watch").state == WatchState::ArmedDuplex && !self.any_armed() {
            self.watch.lock().expect("watch").on_listen_expired();
        }
        let health = duplex::fetch_health(http, &cfg.duplex_url).await;
        set_resident(health.ok && health.loaded == Some(true));
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let actions = self.watch.lock().expect("watch").apply_health(&health, now);
        *self.duplex_health.lock().expect("health") = Some(health);
        self.run_actions(http, &cfg.duplex_url, actions).await;
    }

    fn ensure_pcm_link(self: &Arc<Self>, base: &str) {
        if self.talker_tx.lock().expect("tx").is_some() {
            return;
        }
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        let (in_tx, mut in_rx) = mpsc::unbounded_channel();
        *self.talker_tx.lock().expect("tx") = Some(out_tx);
        let base = base.to_string();
        tokio::spawn(async move {
            duplex::run_pcm_link(&base, out_rx, in_tx).await;
        });
        let this = Arc::clone(self);
        tokio::spawn(async move {
            while let Some(frame) = in_rx.recv().await {
                this.on_talker_frame(frame);
            }
            *this.talker_tx.lock().expect("tx") = None;
        });
    }

    fn on_talker_frame(&self, frame: Inbound) {
        if self.encoder.lock().expect("enc").is_none() {
            return;
        }
        if let Some(speaking) = frame.speaking {
            self.floor
                .lock()
                .expect("floor")
                .on_talker_speaking(speaking);
        }
        if let Some(pcm) = frame.pcm {
            self.send_talker_pcm(&pcm);
        }
        if let Some(caption) = frame.caption {
            tracing::debug!(caption = %caption.chars().take(80).collect::<String>(), "Voice: Talker caption");
        }
    }

    fn send_talker_pcm(&self, mono24k: &[u8]) {
        let allows = self.floor.lock().expect("floor").talker_sends();
        let frames = self.pump.lock().expect("pump").push(mono24k, allows);
        let Some(send) = self.send_opus.lock().expect("opus").clone() else {
            return;
        };
        let mut enc = self.encoder.lock().expect("enc");
        let Some(enc) = enc.as_mut() else {
            return;
        };
        for frame in frames {
            if let Ok(opus) = enc.encode(&frame) {
                send(opus);
            }
        }
    }

    fn forward_user_pcm(&self, pcm: &[u8]) {
        if self.watch.lock().expect("watch").state != WatchState::ArmedDuplex {
            return;
        }
        let mono = downsample_48k_to_24k_mono(pcm, 1);
        if mono.len() < 2 {
            return;
        }
        if let Some(tx) = self.talker_tx.lock().expect("tx").as_ref() {
            let _ = tx.send(mono);
        }
    }

    fn spawn_actions(&self, actions: Vec<WatchAction>) {
        if actions.is_empty() {
            return;
        }
        let url = self.config().duplex_url;
        if url.trim().is_empty() {
            return;
        }
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        handle.spawn(async move {
            let http = reqwest::Client::new();
            for action in actions {
                let op = match action {
                    WatchAction::Warm => "warm",
                    WatchAction::Unload => "unload",
                    WatchAction::MuteOut => "mute_out",
                };
                let _ = duplex::post_control(&http, &url, op).await;
            }
        });
    }

    async fn run_actions(&self, http: &reqwest::Client, url: &str, actions: Vec<WatchAction>) {
        for action in actions {
            let op = match action {
                WatchAction::Warm => "warm",
                WatchAction::Unload => "unload",
                WatchAction::MuteOut => "mute_out",
            };
            let _ = duplex::post_control(http, url, op).await;
        }
    }

    pub async fn handle_transcript<F, Fut>(
        &self,
        transcript: &str,
        speaker_client_id: i32,
        opts: TranscriptOpts,
        execute: F,
    ) -> VoiceTurnResult
    where
        F: FnOnce(String) -> Fut,
        Fut: std::future::Future<Output = Option<String>>,
    {
        use crate::pipeline::VoiceGate;
        use crate::watchword::is_playback_control_reply;

        let gate = {
            let pipe = self.pipeline.lock().expect("pipe");
            pipe.gate(transcript, speaker_client_id, &opts)
        };
        match gate {
            VoiceGate::Ignored => VoiceTurnResult::default(),
            VoiceGate::WatchwordOnly => VoiceTurnResult {
                watchword_only: true,
                ..Default::default()
            },
            VoiceGate::Command(cmd) => {
                let reply = execute(cmd.clone()).await;
                {
                    let pipe = self.pipeline.lock().expect("pipe");
                    // A play leaves the window open so the next person can correct it.
                    if is_playback_control_reply(reply.as_deref()) {
                        pipe.disarm(speaker_client_id);
                    } else if reply.is_some() {
                        pipe.arm(speaker_client_id);
                    }
                }
                let cfg = self.config();
                let should_speak = opts.speak.unwrap_or(true);
                let mut tts_bytes = 0;
                let mut tts_audio = None;
                if should_speak && cfg.respond_with_voice {
                    if let Some(ref r) = reply {
                        if let Some(audio) = self.synthesize_reply(r).await {
                            tts_bytes = audio.len();
                            tts_audio = Some(audio);
                        }
                    }
                }
                VoiceTurnResult {
                    reply,
                    watchword_only: false,
                    tts_bytes,
                    tts_audio,
                    command: Some(cmd),
                }
            }
        }
    }

    pub async fn status(&self) -> VoiceStatus {
        let cfg = self.config();
        let (stt_available, tts_available) = tokio::join!(
            async {
                if cfg.stt_url.trim().is_empty() {
                    false
                } else {
                    probe_http_stt(&cfg.stt_url, Duration::from_secs(10)).await
                }
            },
            async {
                if cfg.tts_url.trim().is_empty() {
                    false
                } else {
                    probe_http_tts(&cfg.tts_url, &cfg.tts_voice, Duration::from_secs(15)).await
                }
            }
        );
        VoiceStatus {
            enabled: cfg.enabled,
            active: self.is_active(),
            stt_url: cfg.stt_url,
            tts_url: cfg.tts_url,
            tts_voice: cfg.tts_voice,
            respond_with_voice: cfg.respond_with_voice,
            stt_available,
            tts_available,
            energy_threshold: cfg.energy_threshold,
            watchword: cfg.watchword,
            require_watchword: cfg.require_watchword,
            inbound_packets: self.inbound_packets(),
            duck_music_on_speech: cfg.duck_music_on_speech,
            text_wake_fallback: cfg.text_wake_fallback,
            mode: if cfg.mode == "duplex" {
                "duplex".into()
            } else {
                "cascaded".into()
            },
            floor: self.floor.lock().expect("floor").floor.as_str().into(),
            wake: self.watch.lock().expect("watch").state.as_str().into(),
            duplex: self
                .duplex_health
                .lock()
                .expect("health")
                .as_ref()
                .map(|h| DuplexStatus {
                    ok: h.ok,
                    loaded: h.loaded.unwrap_or(false),
                    engine: h.engine.clone(),
                    realtime: h.realtime,
                    rtf: h.rtf,
                    vram_mb: h.vram_mb,
                }),
        }
    }
}

fn open_talker_encoder() -> Option<mp_audio::NativeOpus> {
    match mp_audio::NativeOpus::new(48_000, 2) {
        Ok(enc) => Some(enc),
        Err(e) => {
            tracing::warn!(error = %e, "Voice: duplex Opus pump unavailable");
            None
        }
    }
}

fn utterance_from(client_id: i32, pcm: Vec<u8>) -> Utterance {
    let duration_ms = pcm_duration_ms(&pcm, 48_000, 1);
    Utterance {
        speaker_client_id: client_id,
        speaker_uid: Some(format!("clid:{client_id}")),
        pcm,
        sample_rate: 48_000,
        channels: 1,
        duration_ms,
    }
}

fn pcm_duration_ms(pcm: &[u8], sample_rate: u32, channels: u32) -> f64 {
    let ch = channels.max(1) as f64;
    let samples = (pcm.len() as f64) / 2.0 / ch;
    samples / sample_rate as f64 * 1000.0
}

fn needs_pipeline_rebuild(prev: &VoiceConfig, next: &VoiceConfig) -> bool {
    prev.enabled != next.enabled
        || prev.stt_url != next.stt_url
        || prev.tts_url != next.tts_url
        || prev.tts_voice != next.tts_voice
        || prev.watchword != next.watchword
        || prev.require_watchword != next.require_watchword
        || prev.vad_backend != next.vad_backend
        || prev.energy_threshold != next.energy_threshold
        || prev.listen_window_ms != next.listen_window_ms
        || prev.text_wake_fallback != next.text_wake_fallback
}
