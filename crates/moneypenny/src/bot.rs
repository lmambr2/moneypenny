// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Chat → parse → rights → executor. Player frames → TS Opus music send.
//! Never put the model between a user and skip.

use std::sync::Arc;
use std::time::{Duration, Instant};

use mp_control::{
    default_aliases, is_known_command, parse_command, CommandExecutor,
};
use mp_db::Database;
use mp_http::{dispatch_command, RoastRuntime};
use mp_music::{ChannelSpeech, MusicStation, PlayerEvent, QueuedSong, TrackEndKind};
use crate::moves::MoveRuntime;
use mp_rights::{RightsEngine, Scope, Subject};
use mp_ts::{OpusPacket, Target, TsEvent, TsSession, TsSessionExt, CODEC_OPUS_MUSIC};
use mp_radio::{Boundary, RadioRuntime};
use mp_voice::{TranscriptOpts, VoiceRuntime};
use tracing::{info, warn};

const REPLY_DEDUPE_MS: u128 = 4_000;

#[derive(Clone)]
pub struct BotServices {
    pub db: Arc<Database>,
    pub brain: Arc<mp_brain::BrainRuntime>,
    pub rag: Option<Arc<mp_rag::RagRuntime>>,
}

pub struct BotLoop<S> {
    session: Arc<S>,
    executor: CommandExecutor,
    station: Arc<MusicStation>,
    rights: Option<Arc<RightsEngine>>,
    prefix: String,
    aliases: std::collections::HashMap<String, String>,
    services: BotServices,
    voice: Arc<VoiceRuntime>,
    radio: Arc<RadioRuntime>,
    roast: Arc<RoastRuntime>,
    moves: Arc<MoveRuntime>,
    speech: Arc<ChannelSpeech>,
    humans: std::sync::Mutex<std::collections::HashSet<i32>>,
}

impl<S: TsSession + TsSessionExt + Send + Sync + 'static> BotLoop<S> {
    pub fn new(
        session: Arc<S>,
        station: Arc<MusicStation>,
        rights: Option<Arc<RightsEngine>>,
        prefix: String,
        aliases: std::collections::HashMap<String, String>,
        services: BotServices,
        voice: Arc<VoiceRuntime>,
        radio: Arc<RadioRuntime>,
        roast: Arc<RoastRuntime>,
        moves: Arc<MoveRuntime>,
        speech: Arc<ChannelSpeech>,
    ) -> Self {
        let mut aliases = aliases;
        if aliases.is_empty() {
            aliases = default_aliases();
        }
        let executor = CommandExecutor::new(Arc::clone(&station), prefix.clone());
        Self {
            session,
            executor,
            station,
            rights,
            prefix,
            aliases,
            services,
            voice,
            radio,
            roast,
            moves,
            speech,
            humans: std::sync::Mutex::new(std::collections::HashSet::new()),
        }
    }

    pub async fn run(self) {
        let mut events = self.session.subscribe();
        let mut frames = self.station.subscribe_player();
        let mut last_reply: Option<(String, Instant)> = None;
        let mut roast_tick = tokio::time::interval(Duration::from_secs(30));
        roast_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        roast_tick.tick().await;
        info!("bot loop listening for chat");
        loop {
            tokio::select! {
                ev = events.recv() => {
                    match ev {
                        Ok(ev) => {
                            if let Some(text) = self.handle_event(ev).await {
                                if should_dedupe(&last_reply, &text) {
                                    warn!(preview = %text.chars().take(80).collect::<String>(), "suppressing identical channel reply");
                                    continue;
                                }
                                last_reply = Some((text.clone(), Instant::now()));
                                if let Err(e) = self.session.send_text(Target::Channel, &text).await {
                                    warn!(error = %e, "send_text failed");
                                }
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            warn!(skipped = n, "ts event lagged");
                        }
                        Err(_) => break,
                    }
                }
                frame = frames.recv() => {
                    match frame {
                        Ok(PlayerEvent::Frame(opus)) => {
                            let _ = self.session.send_opus(OpusPacket {
                                codec: CODEC_OPUS_MUSIC,
                                data: opus,
                            }).await;
                        }
                        Ok(PlayerEvent::TrackEnd) => {
                            if self.speech.on_track_end() == TrackEndKind::Tts {
                                info!("tts playback ended");
                                continue;
                            }
                            match self.radio.on_track_boundary().await {
                                Boundary::Bumper { label } => {
                                    info!(label = %label, "radio bumper after track end");
                                }
                                Boundary::Advanced { song: Some(name) } => {
                                    info!(name = %name, "advanced after track end");
                                }
                                Boundary::Advanced { song: None } => {}
                            }
                        }
                        Ok(PlayerEvent::Error(e)) => {
                            self.speech.on_player_error();
                            warn!(error = %e, "player");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                        Err(_) => {
                            frames = self.station.subscribe_player();
                        }
                    }
                }
                _ = roast_tick.tick() => {
                    let n = self.humans.lock().expect("humans").len() as u32;
                    if let Some(reel) = self.roast.run_tick(n).await {
                        if should_dedupe(&last_reply, &reel) {
                            continue;
                        }
                        last_reply = Some((reel.clone(), Instant::now()));
                        if let Err(e) = self.session.send_text(Target::Channel, &reel).await {
                            warn!(error = %e, "roast reel send_text failed");
                        }
                    }
                }
            }
        }
    }

    async fn handle_event(&self, ev: TsEvent) -> Option<String> {
        match ev {
            TsEvent::TextMessage {
                invoker_id,
                invoker_uid,
                invoker_name,
                body,
                invoker_groups,
            } => {
                self.handle_chat(invoker_id, invoker_uid, invoker_name, body, invoker_groups)
                    .await
            }
            TsEvent::Poke {
                invoker_id,
                invoker_uid,
                invoker_name,
                body,
            } => {
                let body = if body.trim().starts_with(&self.prefix) {
                    body
                } else {
                    format!("{}{}", self.prefix, body.trim())
                };
                self.handle_chat(invoker_id, invoker_uid, invoker_name, body, Vec::new())
                    .await
            }
            TsEvent::Disconnected { reason } => {
                warn!(reason, "ts disconnected");
                self.station.set_connected(false);
                None
            }
            TsEvent::Connected => {
                info!("ts connected");
                self.station.set_connected(true);
                if std::env::var("MP_PHASE2_SMOKE")
                    .ok()
                    .filter(|s| s == "1")
                    .is_some()
                {
                    let cmd = mp_control::parse_command(
                        "!play sine",
                        &self.prefix,
                        &self.aliases,
                    );
                    if let Some(cmd) = cmd {
                        return self.executor.execute(&cmd).await;
                    }
                }
                Some("Moneypenny online (rust).".into())
            }
            TsEvent::VoiceData {
                client_id,
                codec,
                opus,
            } => {
                self.on_voice(client_id, codec, opus);
                None
            }
            TsEvent::ClientLeave { client_id } => {
                self.voice.on_client_leave(client_id);
                if !self.voice.any_armed() {
                    self.station.player.restore_from_stt_duck();
                }
                let n = {
                    let mut h = self.humans.lock().expect("humans");
                    h.remove(&client_id);
                    h.len() as u32
                };
                self.radio.on_poll(n);
                None
            }
            TsEvent::ClientEnter { client_id, .. } => {
                let own = self.session.client_id();
                if own <= 0 || client_id != own {
                    let n = {
                        let mut h = self.humans.lock().expect("humans");
                        h.insert(client_id);
                        h.len() as u32
                    };
                    self.radio.on_poll(n);
                    self.radio.note_human_activity(client_id);
                }
                None
            }
        }
    }

    async fn handle_chat(
        &self,
        invoker_id: i32,
        invoker_uid: String,
        invoker_name: String,
        body: String,
        invoker_groups: Vec<String>,
    ) -> Option<String> {
        let own = self.session.client_id();
        if own > 0 && invoker_id == own {
            tracing::debug!(message = %body, "ignore own message");
            return None;
        }
        let uid = if invoker_uid.is_empty() {
            format!("clid:{invoker_id}")
        } else {
            invoker_uid
        };
        let parsed = parse_command(&body, &self.prefix, &self.aliases);
        if parsed.is_none() {
            self.roast.capture_line(&uid, &invoker_name, &body, false);
            return None;
        }
        let parsed = parsed?;
        if !is_known_command(&parsed.name) {
            return None;
        }
        let subject = Subject {
            uid: uid.clone(),
            server_groups: invoker_groups,
            nickname: Some(invoker_name),
        };
        self.radio.note_human_activity(invoker_id);
        self.dispose_cmd(&parsed, &subject, Scope::Chat, invoker_id)
            .await
    }

    async fn dispose_cmd(
        &self,
        parsed: &mp_control::ParsedCommand,
        subject: &Subject,
        scope: Scope,
        invoker_clid: i32,
    ) -> Option<String> {
        if matches!(
            parsed.name.as_str(),
            "move" | "moveclient" | "moveall" | "follow"
        ) {
            if let Some(engine) = self.rights.as_deref() {
                if !engine.can(subject, &parsed.name, scope) {
                    return Some(format!(
                        "You don't have permission to use '{}'.",
                        parsed.name
                    ));
                }
            }
            return Some(
                self.moves
                    .handle(
                        &parsed.name,
                        &parsed.args,
                        &parsed.raw_args,
                        invoker_clid,
                        &subject.uid,
                        self.session.client_id(),
                    )
                    .await,
            );
        }
        dispatch_command(
            parsed,
            subject,
            scope,
            &self.executor,
            self.rights.as_deref(),
            &self.services.db,
            &self.services.brain,
            self.services.rag.as_deref(),
            Some(&self.radio),
            Some(&self.roast),
        )
        .await
    }

    fn on_voice(&self, client_id: i32, codec: u8, opus: Vec<u8>) {
        self.radio.note_human_activity(client_id);
        let own = self.session.client_id();
        let Some(ingest) = self.voice.ingest_opus(client_id, &opus, own, codec) else {
            return;
        };
        let cfg = self.voice.config();
        if ingest.speech && cfg.duck_music_on_speech && !self.speech.is_speaking() {
            let _ = self
                .station
                .player
                .duck_for_stt(self.voice.duck_volume() as i32);
        }
        let Some(utt) = ingest.utterance else {
            return;
        };

        let session = Arc::clone(&self.session);
        let voice = Arc::clone(&self.voice);
        let executor = self.executor.clone();
        let station = Arc::clone(&self.station);
        let services = self.services.clone();
        let prefix = self.prefix.clone();
        let aliases = self.aliases.clone();
        let radio = Arc::clone(&self.radio);
        let roast = Arc::clone(&self.roast);
        let moves = Arc::clone(&self.moves);
        let speech = Arc::clone(&self.speech);
        let rights_c = self.rights.clone();
        let session_id = self.session.client_id();
        let speaker_id = utt.speaker_client_id;
        let uid = utt
            .speaker_uid
            .clone()
            .unwrap_or_else(|| format!("clid:{speaker_id}"));

        tokio::spawn(async move {
            let (transcript, keyword) = voice.transcribe_ex(&utt).await;
            if transcript.trim().is_empty() && keyword.is_none() {
                tracing::info!(speaker_id, "Voice: STT returned empty transcript");
                if !voice.any_armed() {
                    station.player.restore_from_stt_duck();
                }
                return;
            }
            let cfg = voice.config();
            let ww = cfg.watchword.to_ascii_lowercase();
            let kws_detected = keyword
                .as_deref()
                .map(|k| k.to_ascii_lowercase() == ww || k.to_ascii_lowercase().contains(&ww))
                .unwrap_or(false);
            let turn = voice
                .handle_transcript(
                    &transcript,
                    speaker_id,
                    TranscriptOpts {
                        speak: Some(cfg.respond_with_voice && !cfg.tts_url.trim().is_empty()),
                        text_wake_fallback: Some(cfg.text_wake_fallback),
                        kws_detected,
                    },
                    |cmd| {
                        let executor = executor.clone();
                        let services = services.clone();
                        let prefix = prefix.clone();
                        let aliases = aliases.clone();
                        let radio = Arc::clone(&radio);
                        let roast = Arc::clone(&roast);
                        let moves = Arc::clone(&moves);
                        let rights = rights_c.clone();
                        let uid = uid.clone();
                        async move {
                            let parsed = parse_command(&format!("{prefix}{cmd}"), &prefix, &aliases)?;
                            if !is_known_command(&parsed.name) {
                                return None;
                            }
                            let subject = Subject {
                                uid,
                                server_groups: Vec::new(),
                                nickname: None,
                            };
                            if matches!(
                                parsed.name.as_str(),
                                "move" | "moveclient" | "moveall" | "follow"
                            ) {
                                if let Some(engine) = rights.as_deref() {
                                    if !engine.can(&subject, &parsed.name, Scope::Voice) {
                                        return Some(format!(
                                            "You don't have permission to use '{}'.",
                                            parsed.name
                                        ));
                                    }
                                }
                                return Some(
                                    moves
                                        .handle(
                                            &parsed.name,
                                            &parsed.args,
                                            &parsed.raw_args,
                                            speaker_id,
                                            &subject.uid,
                                            session_id,
                                        )
                                        .await,
                                );
                            }
                            dispatch_command(
                                &parsed,
                                &subject,
                                Scope::Voice,
                                &executor,
                                rights.as_deref(),
                                &services.db,
                                &services.brain,
                                services.rag.as_deref(),
                                Some(&radio),
                                Some(&roast),
                            )
                            .await
                        }
                    },
                )
                .await;
            if let Some(reply) = turn.reply.as_deref() {
                if let Err(e) = session.send_text(Target::Channel, reply).await {
                    warn!(error = %e, "voice reply send_text failed");
                }
            }
            if let Some(audio) = turn.tts_audio.as_deref() {
                let hold = mp_voice::voice_reply_clears_saved_music(turn.reply.as_deref());
                speech.speak(audio, "wav", hold);
            } else if !turn.watchword_only && !voice.any_armed() {
                station.player.restore_from_stt_duck();
            }
        });
    }
}

fn should_dedupe(last: &Option<(String, Instant)>, text: &str) -> bool {
    let trimmed = text.trim();
    match last {
        Some((prev, at)) if prev == trimmed && at.elapsed().as_millis() < REPLY_DEDUPE_MS => true,
        _ => false,
    }
}

#[allow(dead_code)]
fn _touch_song(s: QueuedSong) -> String {
    s.name
}

#[allow(dead_code)]
const _DEDUP: Duration = Duration::from_millis(REPLY_DEDUPE_MS as u64);
