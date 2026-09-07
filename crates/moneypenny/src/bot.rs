// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Chat → parse → rights → executor. Player frames → TS Opus music send.
//! Never put the model between a user and skip.

use std::sync::Arc;
use std::time::{Duration, Instant};

use mp_brain::{TurnChannel, TurnMode, TurnOptions, TurnRequest, TurnSubject};
use mp_control::{
    default_aliases, is_known_command, parse_command, CommandExecutor,
};
use mp_db::Database;
use mp_music::{MusicStation, PlayerEvent, QueuedSong};
use mp_rag::allowed_classifications_for;
use mp_rights::{RightsEngine, Scope, Subject};
use mp_ts::{OpusPacket, Target, TsEvent, TsSession, TsSessionExt, CODEC_OPUS_MUSIC};
use tracing::{info, warn};

const REPLY_DEDUPE_MS: u128 = 4_000;

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
}

impl<S: TsSession + TsSessionExt + 'static> BotLoop<S> {
    pub fn new(
        session: Arc<S>,
        station: Arc<MusicStation>,
        rights: Option<Arc<RightsEngine>>,
        prefix: String,
        aliases: std::collections::HashMap<String, String>,
        services: BotServices,
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
        }
    }

    pub async fn run(self) {
        let mut events = self.session.subscribe();
        let mut frames = self.station.subscribe_player();
        let mut last_reply: Option<(String, Instant)> = None;
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
                            if let Some(song) = self.station.play_next() {
                                info!(name = %song.name, "advanced after track end");
                            }
                        }
                        Ok(PlayerEvent::Error(e)) => warn!(error = %e, "player"),
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                        Err(_) => {
                            frames = self.station.subscribe_player();
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
            _ => None,
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
        let parsed = parse_command(&body, &self.prefix, &self.aliases)?;
        if !is_known_command(&parsed.name) {
            return None;
        }
        let uid = if invoker_uid.is_empty() {
            format!("clid:{invoker_id}")
        } else {
            invoker_uid
        };
        let subject = Subject {
            uid: uid.clone(),
            server_groups: invoker_groups,
            nickname: Some(invoker_name),
        };
        if let Some(engine) = &self.rights {
            if !engine.can(&subject, &parsed.name, Scope::Chat) {
                return Some(format!(
                    "You don't have permission to use '{}'.",
                    parsed.name
                ));
            }
        }
        match parsed.name.as_str() {
            "remember" => Some(self.cmd_remember(&parsed.args, &uid)),
            "recall" => Some(self.cmd_recall(&uid)),
            "forget" => Some(self.cmd_forget(&parsed.args, &uid)),
            "ask" => Some(self.cmd_ask(&parsed.args, &subject).await),
            "reindex" => Some(self.cmd_reindex(&parsed.args).await),
            _ => self.executor.execute(&parsed).await,
        }
    }

    fn cmd_remember(&self, args: &str, uid: &str) -> String {
        let fact = args.trim();
        if fact.is_empty() {
            return "Usage: !remember <something about you>".into();
        }
        if let Err(e) = self.services.db.memory().add(uid, fact) {
            return format!("Couldn't save that: {e}");
        }
        let injection = self
            .services
            .rag
            .as_ref()
            .is_some_and(|r| r.memory_enabled());
        if injection {
            "Noted — I shan't forget, darling.".into()
        } else {
            "Noted (memory injection is off; an admin can enable it in Settings).".into()
        }
    }

    fn cmd_recall(&self, uid: &str) -> String {
        let facts = self.services.db.memory().recall(uid, 15).unwrap_or_default();
        if facts.is_empty() {
            return "I've nothing on you yet. Use !remember <fact>.".into();
        }
        let lines: Vec<String> = facts
            .iter()
            .enumerate()
            .map(|(i, f)| format!("{}. {}", i + 1, f.fact))
            .collect();
        format!("What I remember about you:\n{}", lines.join("\n"))
    }

    fn cmd_forget(&self, args: &str, uid: &str) -> String {
        let trimmed = args.trim().to_ascii_lowercase();
        if trimmed.is_empty() {
            return "Usage: !forget <number> or !forget all".into();
        }
        if trimmed == "all" {
            let n = self.services.db.memory().forget(uid).unwrap_or(0);
            return if n > 0 {
                format!("Forgotten {n} fact{}.", if n == 1 { "" } else { "s" })
            } else {
                "Nothing to forget.".into()
            };
        }
        let Ok(index) = trimmed.parse::<i64>() else {
            return "Usage: !forget <number> (from !recall) or !forget all".into();
        };
        if index < 1 {
            return "Usage: !forget <number> (from !recall) or !forget all".into();
        }
        match self.services.db.memory().forget_at_index(uid, index) {
            Ok(true) => "Forgotten.".into(),
            _ => "No fact at that number — run !recall to see your list.".into(),
        }
    }

    async fn cmd_ask(&self, args: &str, subject: &Subject) -> String {
        let q = args.trim();
        if q.is_empty() {
            return "Usage: !ask <question>".into();
        }
        let allowed = allowed_classifications_for(self.rights.as_deref(), subject);
        let req = TurnRequest {
            client_turn_id: None,
            channel: TurnChannel::Teamspeak,
            text: q.to_string(),
            conversation_id: Some("channel".into()),
            subject: Some(TurnSubject {
                uid: Some(subject.uid.clone()),
                server_groups: Some(subject.server_groups.clone()),
                allowed_classifications: Some(allowed),
            }),
            mode: Some(TurnMode::Ask),
            options: Some(TurnOptions {
                include_sources: Some(true),
                max_tools: None,
            }),
        };
        let r = self.services.brain.complete(req).await;
        if !r.reply_text.trim().is_empty() {
            r.reply_text
        } else {
            r.error
                .unwrap_or_else(|| "Sorry, the local brain is having a moment.".into())
        }
    }

    async fn cmd_reindex(&self, args: &str) -> String {
        let Some(rag) = self.services.rag.as_ref() else {
            return "RAG is not configured.".into();
        };
        let arg = args.trim();
        let result = if arg.is_empty() {
            mp_rag::reindex_doctrine(&rag.retrieval, &rag.doctrine).await
        } else {
            mp_rag::reindex_sources(
                &rag.retrieval,
                &rag.doctrine,
                [arg.to_string()],
                true,
            )
            .await
        };
        match result {
            Ok(docs) => {
                if docs.is_empty() {
                    "Doctrine already up to date.".into()
                } else {
                    format!(
                        "Reindexed {} doc{}.",
                        docs.len(),
                        if docs.len() == 1 { "" } else { "s" }
                    )
                }
            }
            Err(e) => format!("Reindex failed: {e}"),
        }
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
