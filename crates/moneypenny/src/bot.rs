// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Chat → parse → rights → executor. Player frames → TS Opus music send.
//! Never put the model between a user and skip.

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::auto_follow::AutoFollow;
use crate::moves::MoveRuntime;
use mp_control::{CommandExecutor, default_aliases, is_known_command, parse_command};
use mp_db::Database;
use mp_http::{RoastRuntime, dispatch_command};
use mp_music::{ChannelSpeech, MusicStation, PlayerEvent, QueuedSong, TrackEndKind, VoteAudience};
use mp_radio::{Boundary, RadioRuntime};
use mp_rights::{RightsEngine, Scope, Subject};
use mp_ts::{
    CODEC_OPUS_MUSIC, ChannelCensus, OpusPacket, Target, TsEvent, TsSession, TsSessionExt,
    count_server_humans, vote_listener_census,
};
use mp_voice::{TranscriptOpts, VoiceRuntime};
use tracing::{info, warn};

const REPLY_DEDUPE_MS: u128 = 4_000;

#[derive(Clone)]
pub struct BotServices {
    pub db: Arc<Database>,
    pub brain: Arc<mp_brain::BrainRuntime>,
    pub rag: Option<Arc<mp_rag::RagRuntime>>,
    pub sc_org: Arc<mp_http::ScOrgRuntime>,
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
    humans: Arc<std::sync::Mutex<std::collections::HashSet<i32>>>,
    llm_idle: Arc<std::sync::Mutex<mp_brain::LlmIdleGate>>,
    session_roles: Arc<mp_http::SessionHandle>,
    follow: Arc<AutoFollow>,
    reply_dedupe: Arc<std::sync::Mutex<Option<(String, Instant)>>>,
}

impl<S> Clone for BotLoop<S> {
    fn clone(&self) -> Self {
        Self {
            session: Arc::clone(&self.session),
            executor: self.executor.clone(),
            station: Arc::clone(&self.station),
            rights: self.rights.clone(),
            prefix: self.prefix.clone(),
            aliases: self.aliases.clone(),
            services: self.services.clone(),
            voice: Arc::clone(&self.voice),
            radio: Arc::clone(&self.radio),
            roast: Arc::clone(&self.roast),
            moves: Arc::clone(&self.moves),
            speech: Arc::clone(&self.speech),
            humans: Arc::clone(&self.humans),
            llm_idle: Arc::clone(&self.llm_idle),
            session_roles: Arc::clone(&self.session_roles),
            follow: Arc::clone(&self.follow),
            reply_dedupe: Arc::clone(&self.reply_dedupe),
        }
    }
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
        follow: AutoFollow,
        executor: CommandExecutor,
        session_roles: Arc<mp_http::SessionHandle>,
    ) -> Self {
        let mut aliases = aliases;
        if aliases.is_empty() {
            aliases = default_aliases();
        }
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
            humans: Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
            llm_idle: Arc::new(std::sync::Mutex::new(mp_brain::LlmIdleGate::new(
                mp_brain::LLM_IDLE_UNLOAD_SECONDS_DEFAULT,
            ))),
            session_roles,
            follow: Arc::new(follow),
            reply_dedupe: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    pub async fn run(self) {
        let mut events = self.session.subscribe();
        let mut frames = self.station.subscribe_player();
        let mut roast_tick = tokio::time::interval(Duration::from_secs(30));
        roast_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        roast_tick.tick().await;
        info!("bot loop listening for chat");
        loop {
            tokio::select! {
                biased;
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
                            let this = self.clone();
                            tokio::spawn(async move {
                                if this.radio.enabled() {
                                    match this.radio.on_track_boundary().await {
                                        Boundary::Bumper { label } => {
                                            info!(label = %label, "radio bumper after track end");
                                        }
                                        Boundary::Advanced { song: Some(name) } => {
                                            info!(name = %name, "advanced after track end");
                                        }
                                        Boundary::Advanced { song: None } => {}
                                    }
                                } else if let Some(s) = this.station.play_next_async().await {
                                    info!(name = %format!("{} - {}", s.name, s.artist), "advanced after track end");
                                }
                            });
                        }
                        Ok(PlayerEvent::NowPlaying { name, artist, album }) => {
                            let line = Self::now_playing_line(&name, &artist, &album);
                            let this = self.clone();
                            tokio::spawn(async move {
                                this.reply_channel(line).await;
                                if let Err(e) = this.session.set_away(true).await {
                                    warn!(error = %e, "away clear failed");
                                }
                            });
                        }
                        Ok(PlayerEvent::Idle) => {
                            let this = self.clone();
                            tokio::spawn(async move {
                                if let Err(e) = this.session.set_away(false).await {
                                    warn!(error = %e, "away set failed");
                                }
                            });
                        }
                        Ok(PlayerEvent::Error(e)) => {
                            self.speech.on_player_error();
                            warn!(error = %e, "player");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            warn!(skipped = n, "audio frames lagged — playback may stutter");
                        }
                        Err(_) => {
                            frames = self.station.subscribe_player();
                        }
                    }
                }
                ev = events.recv() => {
                    match ev {
                        Ok(ev) => {
                            let spawn_cmd = matches!(
                                ev,
                                TsEvent::TextMessage { .. } | TsEvent::Poke { .. }
                            );
                            if spawn_cmd {
                                let this = self.clone();
                                tokio::spawn(async move {
                                    if let Some(text) = this.handle_event(ev).await {
                                        this.reply_channel(text).await;
                                    }
                                });
                            } else if let Some(text) = self.handle_event(ev).await {
                                self.reply_channel(text).await;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                            warn!(skipped = n, "ts event lagged");
                        }
                        Err(_) => break,
                    }
                }
                _ = roast_tick.tick() => {
                    let this = self.clone();
                    tokio::spawn(async move {
                        let listed = this.session.list_clients_result().await;
                        let census = match &listed {
                            Ok(all) if !all.is_empty() => {
                                AutoFollow::humans_in_own(&*this.session, all)
                            }
                            _ => None,
                        };
                        let Some(mut n) = census else {
                            return;
                        };
                        if n == 0 {
                            if this.follow.maybe_follow(&*this.session, 0).await.is_some() {
                                if let Ok(all) = this.session.list_clients_result().await {
                                    if let Some(n2) = AutoFollow::humans_in_own(&*this.session, &all)
                                    {
                                        n = n2;
                                    }
                                }
                            }
                        }
                        this.radio.on_poll(n);
                        this.note_llm_idle(n);
                        if let Ok(all) = &listed {
                            let server_humans = count_server_humans(all, this.session.client_id());
                            let now_ms = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0);
                            if this.session_roles.note_server_humans(server_humans, now_ms) {
                                let roles = std::sync::Arc::clone(&this.session_roles);
                                tokio::spawn(async move {
                                    let msg = roles.run_auto_clear().await;
                                    tracing::info!(%msg, "session-roles auto-clear on empty server");
                                });
                            }
                        }
                        if let Some(reel) = this.roast.run_tick(n).await {
                            this.reply_channel(reel).await;
                        }
                    });
                }
            }
        }
    }

    fn now_playing_line(name: &str, artist: &str, album: &str) -> String {
        let album = album.trim();
        if album.is_empty() {
            format!("♪ Now Playing: {name} - {artist}")
        } else {
            format!("♪ Now Playing: {name} - {artist} [{album}]")
        }
    }

    async fn reply_channel(&self, text: String) {
        {
            let mut last = self.reply_dedupe.lock().expect("dedupe");
            if should_dedupe(&*last, &text) {
                warn!(preview = %text.chars().take(80).collect::<String>(), "suppressing identical channel reply");
                return;
            }
            *last = Some((text.clone(), Instant::now()));
        }
        if let Err(e) = self.session.send_text(Target::Channel, &text).await {
            warn!(error = %e, "send_text failed");
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
                let groups = self.session.groups_for(invoker_id, Vec::new()).await;
                self.handle_chat(invoker_id, invoker_uid, invoker_name, body, groups)
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
                    let cmd = mp_control::parse_command("!play sine", &self.prefix, &self.aliases);
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
                self.note_llm_idle(n);
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
                    self.radio.note_human_activity(client_id);
                    self.note_llm_idle(n);
                }
                None
            }
        }
    }

    fn note_llm_idle(&self, humans: u32) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let event = self
            .llm_idle
            .lock()
            .expect("idle")
            .on_human_count(humans, now);
        match event {
            mp_brain::IdleEvent::Unload => {
                let brain = Arc::clone(&self.services.brain);
                tokio::spawn(async move {
                    brain.unload().await;
                });
            }
            mp_brain::IdleEvent::Warm => {
                let brain = Arc::clone(&self.services.brain);
                tokio::spawn(async move {
                    brain.warm().await;
                });
            }
            mp_brain::IdleEvent::None | mp_brain::IdleEvent::Armed => {}
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
        if matches!(parsed.name.as_str(), "mute" | "kick") {
            if let Some(engine) = self.rights.as_deref() {
                if !engine.can(subject, &parsed.name, scope) {
                    return Some(format!(
                        "You don't have permission to use '{}'.",
                        parsed.name
                    ));
                }
            }
            return Some(self.moderation(&parsed.name, &parsed.args, subject).await);
        }
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
            Some(&self.voice),
            Some(&self.services.sc_org),
            self.listeners_for(&parsed.name).await,
            Some(self.session_roles.as_ref()),
        )
        .await
    }

    async fn listeners_for(&self, command: &str) -> VoteAudience {
        if command != "vote" {
            return VoteAudience::NotOnTeamspeak;
        }
        if !self.session.is_connected() {
            return VoteAudience::Uncounted;
        }
        match self.session.list_clients_result().await {
            Ok(all) => match vote_listener_census(
                &all,
                self.session.client_id(),
                self.session.channel_id(),
                true,
            ) {
                ChannelCensus::Failed => VoteAudience::Uncounted,
                ChannelCensus::Humans(n) => VoteAudience::Listeners(n),
            },
            Err(_) => VoteAudience::Uncounted,
        }
    }

    async fn moderation(&self, action: &str, target: &str, subject: &Subject) -> String {
        let target = target.trim();
        if target.is_empty() {
            return format!("Usage: {}{action} <nickname|clid>", self.prefix);
        }
        if !self.session.is_connected() {
            return "Bot is not connected — moderation skipped (music unaffected).".into();
        }
        let t = target.to_ascii_lowercase();
        let own = self.session.client_id();
        let all = self.session.list_clients().await;
        let hit = all.iter().find(|c| {
            if own > 0 && c.id == own {
                return false;
            }
            let nick = c.nickname.to_ascii_lowercase();
            let id = c.id.to_string();
            id == t || nick.eq_ignore_ascii_case(target) || (t.len() >= 3 && nick.contains(&t))
        });
        let Some(hit) = hit else {
            return format!("No client matching \"{target}\" in channel. Music unaffected.");
        };
        let clid = hit.id;
        let label = if hit.nickname.is_empty() {
            clid.to_string()
        } else {
            hit.nickname.clone()
        };
        let _ = subject;
        if action == "kick" {
            match self.session.kick_client(clid, "Moneypenny kick").await {
                Ok(()) => format!("Kicked {label} from the channel. Music unaffected."),
                Err(e) => format!("Moderation kick failed open: {e}. Music unaffected."),
            }
        } else {
            match self.session.poke_client(clid, "Moderation: mute").await {
                Ok(()) => format!(
                    "Moderation: mute requested for {label} (apply via server groups if API unavailable)."
                ),
                Err(e) => format!("Moderation mute failed open: {e}. Music unaffected."),
            }
        }
    }

    fn on_voice(&self, client_id: i32, codec: u8, opus: Vec<u8>) {
        self.radio.note_human_activity(client_id);
        let own = self.session.client_id();
        let Some(ingest) = self.voice.ingest_opus(client_id, &opus, own, codec) else {
            return;
        };
        // Node ducks only after the wake word. Ducking every voice packet
        // chops the song whenever anyone talks, and STT is often down.
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
        let session_roles = Arc::clone(&self.session_roles);
        let session_id = self.session.client_id();
        let speaker_id = utt.speaker_client_id;
        let uid = utt
            .speaker_uid
            .clone()
            .unwrap_or_else(|| format!("clid:{speaker_id}"));

        tokio::spawn(async move {
            let groups = session.groups_for(speaker_id, Vec::new()).await;
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
            if kws_detected && cfg.duck_music_on_speech && !speech.is_speaking() {
                let _ = station.player.duck_for_stt(voice.duck_volume() as i32);
            }
            let speak_buf = Arc::new(std::sync::Mutex::new(String::new()));
            let streamed = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let (sentence_tx, mut sentence_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
            {
                let buf = Arc::clone(&speak_buf);
                let streamed_flag = Arc::clone(&streamed);
                let tx = sentence_tx.clone();
                services
                    .brain
                    .set_delta_hook(Some(Arc::new(move |delta| {
                        let ready = {
                            let mut b = buf.lock().expect("stream");
                            mp_voice::push_stream_delta(&mut b, delta)
                        };
                        for sentence in ready {
                            streamed_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                            let _ = tx.send(sentence);
                        }
                    })))
                    .await;
            }
            let voice_play = Arc::clone(&voice);
            let speech_play = Arc::clone(&speech);
            let player = tokio::spawn(async move {
                while let Some(sentence) = sentence_rx.recv().await {
                    let spoken = mp_voice::text_to_spoken(&sentence);
                    if spoken.is_empty() {
                        continue;
                    }
                    if let Some(audio) = voice_play.synthesize_sentence(&spoken).await {
                        speech_play.enqueue_sentence(&audio, "wav");
                    }
                }
            });
            let turn = voice
                .handle_transcript(
                    &transcript,
                    speaker_id,
                    TranscriptOpts {
                        // Sentences air from the delta hook. Bulk TTS only if nothing streamed.
                        speak: Some(false),
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
                        let voice_rt = Arc::clone(&voice);
                        let sc_org = Arc::clone(&services.sc_org);
                        let moves = Arc::clone(&moves);
                        let rights = rights_c.clone();
                        let uid = uid.clone();
                        let groups = groups.clone();
                        let session_vote = Arc::clone(&session);
                        async move {
                            let parsed =
                                parse_command(&format!("{prefix}{cmd}"), &prefix, &aliases)?;
                            if !is_known_command(&parsed.name) {
                                return None;
                            }
                            let subject = Subject {
                                uid,
                                server_groups: groups,
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
                            let listeners = if parsed.name == "vote" {
                                if !session_vote.is_connected() {
                                    VoteAudience::Uncounted
                                } else {
                                    match session_vote.list_clients_result().await {
                                        Ok(all) => match vote_listener_census(
                                            &all,
                                            session_vote.client_id(),
                                            session_vote.channel_id(),
                                            true,
                                        ) {
                                            ChannelCensus::Failed => VoteAudience::Uncounted,
                                            ChannelCensus::Humans(n) => VoteAudience::Listeners(n),
                                        },
                                        Err(_) => VoteAudience::Uncounted,
                                    }
                                }
                            } else {
                                VoteAudience::NotOnTeamspeak
                            };
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
                                Some(&voice_rt),
                                Some(&sc_org),
                                listeners,
                                Some(session_roles.as_ref()),
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
            services.brain.set_delta_hook(None).await;
            {
                let rest = {
                    let mut b = speak_buf.lock().expect("stream");
                    std::mem::take(&mut *b)
                };
                let rest = mp_voice::text_to_spoken(rest.trim());
                if !rest.is_empty() {
                    streamed.store(true, std::sync::atomic::Ordering::SeqCst);
                    let _ = sentence_tx.send(rest);
                }
            }
            drop(sentence_tx);
            let _ = player.await;
            let want_voice = cfg.respond_with_voice && !cfg.tts_url.trim().is_empty();
            if streamed.load(std::sync::atomic::Ordering::SeqCst) {
                tracing::debug!("voice sentences aired in order from the token stream");
            } else if want_voice {
                if let Some(reply) = turn.reply.as_deref() {
                    if let Some(audio) = voice.synthesize_reply(reply).await {
                        let hold = mp_voice::voice_reply_clears_saved_music(Some(reply));
                        speech.speak(&audio, "wav", hold);
                    } else if !turn.watchword_only && !voice.any_armed() {
                        station.player.restore_from_stt_duck();
                    }
                } else if !turn.watchword_only && !voice.any_armed() {
                    station.player.restore_from_stt_duck();
                }
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
