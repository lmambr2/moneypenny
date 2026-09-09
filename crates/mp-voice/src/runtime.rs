// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use mp_audio::{normalize_pcm_for_stt, pcm_peak, MIN_PCM_BOOST_PEAK, STT_TARGET_PEAK};
use mp_config::{effective_duck_volume, VoiceConfig, MIN_LISTEN_WINDOW_MS};

use crate::pipeline::{TranscriptOpts, VoicePipeline, VoiceTurnResult};
use crate::probe::{probe_http_stt, probe_http_tts};
use crate::stt::HttpSttClient;
use crate::tts::HttpTtsClient;
use crate::vad::SilenceSegmenter;
use crate::{Utterance, VoiceStatus};

/// TeamSpeak music codec — never feed this to STT.
const CODEC_OPUS_MUSIC: u8 = 5;

pub struct IngestResult {
    pub utterance: Option<Utterance>,
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
        });
        rt.reconfigure();
        rt
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
            tracing::info!(client_id, codec, bytes = opus.len(), "Voice: first inbound packet");
        }
        let Some(dec) = cap.decoder.as_mut() else {
            return None;
        };
        let decoded = dec.decode_voice(opus).ok()?;
        if !decoded.ok {
            return None;
        }
        let pcm = decoded.pcm;
        let raw_peak = pcm_peak(&pcm).unwrap_or(0);
        let speech = raw_peak >= MIN_PCM_BOOST_PEAK;
        let pcm_stt = normalize_pcm_for_stt(&pcm, STT_TARGET_PEAK, 120.0, MIN_PCM_BOOST_PEAK)
            .unwrap_or_else(|_| pcm.clone());

        let threshold = cap.energy_threshold;
        let seg = cap
            .segmenters
            .entry(client_id)
            .or_insert_with(|| SilenceSegmenter::for_teamspeak(threshold));
        let done = seg.push(&pcm_stt);
        drop(cap);

        let utterance = done.map(|pcm| {
            let duration_ms = pcm_duration_ms(&pcm, 48_000, 1);
            Utterance {
                speaker_client_id: client_id,
                speaker_uid: Some(format!("clid:{client_id}")),
                pcm,
                sample_rate: 48_000,
                channels: 1,
                duration_ms,
            }
        });
        Some(IngestResult {
            utterance,
            speech,
            raw_peak,
        })
    }

    pub async fn transcribe(&self, u: &Utterance) -> String {
        self.transcribe_ex(u).await.0
    }

    pub async fn transcribe_ex(&self, u: &Utterance) -> (String, Option<String>) {
        let url = self.config().stt_url;
        if url.trim().is_empty() {
            return (String::new(), None);
        }
        HttpSttClient::new(url).transcribe_ex(u).await
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
        use crate::speak::text_to_spoken;
        use crate::watchword::{
            is_playback_control_reply, is_playback_start_reply, should_speak_voice_reply,
            voice_spoken_ack,
        };

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
                    if is_playback_start_reply(reply.as_deref())
                        || is_playback_control_reply(reply.as_deref())
                    {
                        pipe.disarm(speaker_client_id);
                    } else if reply.is_some() {
                        pipe.arm(speaker_client_id);
                    }
                }
                let cfg = self.config();
                let should_speak = opts.speak.unwrap_or(true);
                let mut tts_bytes = 0;
                let mut tts_audio = None;
                if should_speak && cfg.respond_with_voice && !cfg.tts_url.trim().is_empty() {
                    if let Some(ref r) = reply {
                        let spoken = voice_spoken_ack(Some(r)).map(|s| s.to_string());
                        let tts_text = spoken.unwrap_or_else(|| text_to_spoken(r));
                        if !is_playback_start_reply(Some(r))
                            && should_speak_voice_reply(&tts_text, 900)
                            && !tts_text.is_empty()
                        {
                            let tts = HttpTtsClient::new(&cfg.tts_url, &cfg.tts_voice);
                            match tts.synthesize(&tts_text).await {
                                Ok((audio, _)) => {
                                    tts_bytes = audio.len();
                                    if !audio.is_empty() {
                                        tts_audio = Some(audio);
                                    }
                                }
                                Err(e) => tracing::warn!(error = %e, "Voice: TTS failed"),
                            }
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
        }
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
