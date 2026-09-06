// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Chat → parse → rights → executor. Player frames → TS Opus music send.
//! Never put the model between a user and skip. Unknown commands are not
//! sent to an LLM in Phase 2.

use std::sync::Arc;
use std::time::{Duration, Instant};

use mp_control::{
    default_aliases, is_known_command, parse_command, CommandExecutor,
};
use mp_music::{MusicStation, PlayerEvent, QueuedSong};
use mp_rights::{RightsEngine, Scope, Subject};
use mp_ts::{OpusPacket, Target, TsEvent, TsSession, TsSessionExt, CODEC_OPUS_MUSIC};
use tracing::{info, warn};

const REPLY_DEDUPE_MS: u128 = 4_000;

pub struct BotLoop<S> {
    session: Arc<S>,
    executor: CommandExecutor,
    station: Arc<MusicStation>,
    rights: Option<Arc<RightsEngine>>,
    prefix: String,
    aliases: std::collections::HashMap<String, String>,
}

impl<S: TsSession + TsSessionExt + 'static> BotLoop<S> {
    pub fn new(
        session: Arc<S>,
        station: Arc<MusicStation>,
        rights: Option<Arc<RightsEngine>>,
        prefix: String,
        aliases: std::collections::HashMap<String, String>,
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
                Some("Moneypenny online (rust phase 2).".into())
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
            // Phase 2: no LLM fuzzy-intent fallback.
            return None;
        }
        if let Some(engine) = &self.rights {
            let subject = Subject {
                uid: if invoker_uid.is_empty() {
                    format!("clid:{invoker_id}")
                } else {
                    invoker_uid
                },
                server_groups: invoker_groups,
                nickname: Some(invoker_name),
            };
            if !engine.can(&subject, &parsed.name, Scope::Chat) {
                return Some(format!(
                    "You don't have permission to use '{}'.",
                    parsed.name
                ));
            }
        }
        self.executor.execute(&parsed).await
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
