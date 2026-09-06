// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! TeamSpeak 3/6 session façade.
//!
//! Phase 0: trait + in-memory mock. Live transport is a week-1 go/no-go:
//! - Option A: `tsclient-rs` (spike in `examples/join.rs`)
//! - Option B: keep `@honeybbq/teamspeak-client` as a Node sidecar
//!
//! HTTP Query (`:10080` + `TS6_API_KEY`) is a separate `reqwest` client and
//! is **not** blocked on the UDP voice spike.

use tokio::sync::broadcast;

#[derive(Debug, thiserror::Error)]
pub enum TsError {
    #[error("{0}")]
    Message(String),
    #[error("not connected")]
    NotConnected,
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
    Disconnected { reason: String },
    TextMessage { invoker_id: i32, invoker_name: String, body: String },
    Poke { invoker_id: i32, invoker_name: String, body: String },
    VoiceData { client_id: i32, opus: Vec<u8> },
    ClientEnter { client_id: i32, nickname: String },
    ClientLeave { client_id: i32 },
}

pub trait TsSession: Send + Sync {
    fn send_text(
        &self,
        target: Target,
        body: &str,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
    fn subscribe(&self) -> broadcast::Receiver<TsEvent>;
    fn send_opus(
        &self,
        pkt: OpusPacket,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
}

/// In-memory session used until Option A/B is chosen.
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

    async fn send_opus(&self, _pkt: OpusPacket) -> Result<()> {
        if !self.connected.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(TsError::NotConnected);
        }
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
            invoker_name: "Bond".into(),
            body: "!skip".into(),
        });
        match rx.recv().await.unwrap() {
            TsEvent::TextMessage { body, .. } => assert_eq!(body, "!skip"),
            other => panic!("unexpected {other:?}"),
        }
    }
}
