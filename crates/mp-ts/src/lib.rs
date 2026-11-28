// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! TeamSpeak 3/6 session façade.
//!
//! Live transport (Option A): `tsclient-rs` behind the `tsclient-rs` feature.
//! HTTP Query (`:10080` + `TS6_API_KEY`) is a separate `reqwest` client.

mod presence;
mod reconnect;

#[cfg(feature = "tsclient-rs")]
mod live;
#[cfg(feature = "tsclient-rs")]
mod query;

pub use presence::{
    ChannelCensus, ChannelPopulation, PresenceClient, count_channel_humans, count_server_humans,
    pick_busiest_channel, resolve_own_channel_id, tally_channel_populations, vote_listener_census,
};
pub use reconnect::{ReconnectDriver, ReconnectScheduler, reconnect_delay_ms};

#[cfg(feature = "tsclient-rs")]
pub use live::{LiveSession, TsConnectConfig};
#[cfg(feature = "tsclient-rs")]
pub use query::{
    QueryChannel, QueryClient, QueryClientRow, parse_channel_list, parse_client_list,
    parse_member_db_ids,
};

use tokio::sync::broadcast;

#[derive(Debug, thiserror::Error)]
pub enum TsError {
    #[error("{0}")]
    Message(String),
    #[error("not connected")]
    NotConnected,
}

/// One `sendtextmessage` command. A multi-thousand-character analyst write-up
/// misses the 4s command ack and the voice link then drops. Each piece stays
/// under this many characters, including a `(n/m)` marker when split.
pub const CHANNEL_TEXT_CHARS: usize = 750;

/// Split channel or private text into commands TeamSpeak will ack.
/// A short message is returned unchanged. Longer text breaks on a paragraph,
/// then a line, then a word.
pub fn split_channel_text(text: &str) -> Vec<String> {
    let mut budget = CHANNEL_TEXT_CHARS;
    loop {
        let parts = split_at(text, budget);
        if parts.len() <= 1 {
            return parts;
        }
        let width = marker_width(parts.len());
        let next = CHANNEL_TEXT_CHARS.saturating_sub(width).max(32);
        if next == budget {
            return number_parts(parts);
        }
        budget = next;
    }
}

fn marker_width(count: usize) -> usize {
    let digits = count.to_string().len();
    // " (digits/digits)"
    3 + digits + 1 + digits + 1
}

fn number_parts(parts: Vec<String>) -> Vec<String> {
    let total = parts.len();
    parts
        .into_iter()
        .enumerate()
        .map(|(i, part)| format!("{part} ({}/{})", i + 1, total))
        .collect()
}

fn split_at(text: &str, limit: usize) -> Vec<String> {
    let limit = limit.max(1);
    let mut rest = text;
    let mut out = Vec::new();
    if rest.is_empty() {
        return vec![String::new()];
    }
    while !rest.is_empty() {
        if rest.chars().count() <= limit {
            out.push(rest.to_string());
            break;
        }
        let end = find_break(rest, limit);
        let (head, tail) = split_chars(rest, end);
        let head = head.trim_end();
        if head.is_empty() {
            let (one, tail) = split_chars(rest, 1);
            out.push(one.to_string());
            rest = tail;
            continue;
        }
        out.push(head.to_string());
        rest = tail.trim_start();
    }
    out
}

/// Character count of the prefix to keep. Prefers a paragraph, then a line,
/// then a space, and otherwise cuts on a character boundary.
fn find_break(text: &str, limit: usize) -> usize {
    let window: String = text.chars().take(limit).collect();
    if let Some(i) = window.rfind("\n\n") {
        let at = window[..i].chars().count();
        if at > 0 {
            return at;
        }
    }
    if let Some(i) = window.rfind('\n') {
        let at = window[..i].chars().count();
        if at > 0 {
            return at;
        }
    }
    if let Some(i) = window.rfind(' ') {
        let at = window[..i].chars().count();
        if at > 0 {
            return at;
        }
    }
    limit.min(text.chars().count()).max(1)
}

fn split_chars(text: &str, n: usize) -> (&str, &str) {
    match text.char_indices().nth(n) {
        Some((byte, _)) => text.split_at(byte),
        None => (text, ""),
    }
}

pub type Result<T> = std::result::Result<T, TsError>;

#[derive(Debug, Clone)]
pub enum Target {
    Channel,
    Client { id: i32 },
    Poke { id: i32 },
}

#[derive(Debug, Clone)]
pub struct OpusPacket {
    pub codec: u8,
    pub data: Vec<u8>,
}

/// TeamSpeak music codec id (Opus music). Matches `@moneypenny/ts6-client`.
pub const CODEC_OPUS_MUSIC: u8 = 5;
/// TeamSpeak voice codec id (Opus voice).
pub const CODEC_OPUS_VOICE: u8 = 4;

#[derive(Debug, Clone)]
pub enum TsEvent {
    Connected,
    Disconnected {
        reason: String,
    },
    TextMessage {
        invoker_id: i32,
        invoker_uid: String,
        invoker_name: String,
        body: String,
        invoker_groups: Vec<String>,
    },
    Poke {
        invoker_id: i32,
        invoker_uid: String,
        invoker_name: String,
        body: String,
    },
    VoiceData {
        client_id: i32,
        codec: u8,
        opus: Vec<u8>,
    },
    ClientEnter {
        client_id: i32,
        nickname: String,
    },
    ClientLeave {
        client_id: i32,
    },
}

pub trait TsSession: Send + Sync {
    fn send_text(
        &self,
        target: Target,
        body: &str,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
    fn subscribe(&self) -> broadcast::Receiver<TsEvent>;
    fn send_opus(&self, pkt: OpusPacket) -> impl std::future::Future<Output = Result<()>> + Send;
    /// Music frames call this from a plain thread. `blocking` on the tokio
    /// client mutex panics if this runs on a runtime worker.
    fn send_opus_now(&self, pkt: OpusPacket) -> Result<()>;
}

pub trait TsSessionExt: TsSession {
    fn client_id(&self) -> i32;
    fn is_connected(&self) -> bool;
    fn channel_id(&self) -> u64;
    fn list_clients(&self) -> impl std::future::Future<Output = Vec<PresenceClient>> + Send;
    fn list_clients_result(
        &self,
    ) -> impl std::future::Future<Output = Result<Vec<PresenceClient>>> + Send;
    fn join_channel(&self, cid: u64) -> impl std::future::Future<Output = bool> + Send;
    fn resolve_channel_id_by_name(
        &self,
        name: &str,
    ) -> impl std::future::Future<Output = Option<u64>> + Send;
    fn groups_for(
        &self,
        clid: i32,
        fallback: Vec<String>,
    ) -> impl std::future::Future<Output = Vec<String>> + Send;
    fn poke_client(
        &self,
        clid: i32,
        message: &str,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
    fn kick_client(
        &self,
        clid: i32,
        message: &str,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
    fn set_away(&self, playing: bool) -> impl std::future::Future<Output = Result<()>> + Send;
}

/// In-memory session used until Option A/B is chosen, and in tests.
#[derive(Clone)]
pub struct MockSession {
    tx: broadcast::Sender<TsEvent>,
    connected: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Default for MockSession {
    fn default() -> Self {
        Self::new()
    }
}

impl MockSession {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(64);
        Self {
            tx,
            connected: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
        }
    }

    pub fn inject(&self, event: TsEvent) {
        let _ = self.tx.send(event);
    }

    pub fn disconnect(&self) {
        self.connected
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let _ = self.tx.send(TsEvent::Disconnected {
            reason: "mock".into(),
        });
    }
}

impl TsSession for MockSession {
    async fn send_text(&self, _target: Target, _body: &str) -> Result<()> {
        if !self.connected.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(TsError::NotConnected);
        }
        Ok(())
    }

    fn subscribe(&self) -> broadcast::Receiver<TsEvent> {
        self.tx.subscribe()
    }

    async fn send_opus(&self, pkt: OpusPacket) -> Result<()> {
        self.send_opus_now(pkt)
    }

    fn send_opus_now(&self, _pkt: OpusPacket) -> Result<()> {
        if !self.connected.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(TsError::NotConnected);
        }
        Ok(())
    }
}

impl TsSessionExt for MockSession {
    fn client_id(&self) -> i32 {
        1
    }
    fn is_connected(&self) -> bool {
        self.connected.load(std::sync::atomic::Ordering::SeqCst)
    }
    fn channel_id(&self) -> u64 {
        0
    }
    async fn list_clients(&self) -> Vec<PresenceClient> {
        Vec::new()
    }
    async fn list_clients_result(&self) -> Result<Vec<PresenceClient>> {
        Ok(Vec::new())
    }
    async fn join_channel(&self, _cid: u64) -> bool {
        false
    }
    async fn resolve_channel_id_by_name(&self, _name: &str) -> Option<u64> {
        None
    }
    async fn groups_for(&self, _clid: i32, fallback: Vec<String>) -> Vec<String> {
        fallback
    }
    async fn poke_client(&self, _clid: i32, _message: &str) -> Result<()> {
        Ok(())
    }
    async fn kick_client(&self, _clid: i32, _message: &str) -> Result<()> {
        Ok(())
    }
    async fn set_away(&self, _playing: bool) -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_chat_and_opus() {
        let s = MockSession::new();
        let mut rx = s.subscribe();
        s.send_text(Target::Channel, "hello").await.unwrap();
        s.send_opus(OpusPacket {
            codec: CODEC_OPUS_MUSIC,
            data: vec![0, 1],
        })
        .await
        .unwrap();
        s.inject(TsEvent::TextMessage {
            invoker_id: 1,
            invoker_uid: "uid".into(),
            invoker_name: "Bond".into(),
            body: "!skip".into(),
            invoker_groups: vec![],
        });
        match rx.recv().await.unwrap() {
            TsEvent::TextMessage { body, .. } => assert_eq!(body, "!skip"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn short_channel_text_is_one_piece() {
        assert_eq!(split_channel_text("Ready."), vec!["Ready.".to_string()]);
        assert_eq!(split_channel_text(""), vec![String::new()]);
    }

    #[test]
    fn long_channel_text_splits_on_words_and_stays_under_the_cap() {
        let text = "alpha beta gamma delta ".repeat(80);
        let parts = split_channel_text(&text);
        assert!(parts.len() > 1, "parts {}", parts.len());
        for (i, part) in parts.iter().enumerate() {
            assert!(
                part.chars().count() <= CHANNEL_TEXT_CHARS,
                "part {i} is {} chars",
                part.chars().count()
            );
            assert!(part.ends_with(&format!(" ({}/{})", i + 1, parts.len())));
        }
        let words: Vec<&str> = parts
            .iter()
            .flat_map(|p| p.split_whitespace())
            .filter(|w| !w.starts_with('('))
            .collect();
        assert!(words.iter().all(|w| *w == "alpha" || *w == "beta" || *w == "gamma" || *w == "delta"));
        assert_eq!(words.iter().filter(|w| **w == "alpha").count(), 80);
    }

    #[test]
    fn split_prefers_a_paragraph_and_keeps_char_boundaries() {
        let para = format!("{}\n\n{}", "one ".repeat(200), "two ".repeat(200));
        let parts = split_channel_text(&para);
        assert!(parts.len() >= 2);
        assert!(parts[0].contains("one"));
        assert!(!parts[0].contains("two"));
        let wide = "é".repeat(CHANNEL_TEXT_CHARS + 40);
        let cut = split_channel_text(&wide);
        assert!(cut.len() > 1);
        for part in &cut {
            assert!(part.is_char_boundary(part.len()));
        }
    }
}
