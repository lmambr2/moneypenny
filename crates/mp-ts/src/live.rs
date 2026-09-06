// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Option A live session: tsclient-rs + HTTP Query groups.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{broadcast, Mutex};
use tsclient_rs::{self, Client, ClientOptions, EventMap};

use crate::query::QueryClient;
use crate::{OpusPacket, Result, Target, TsError, TsEvent, TsSession, CODEC_OPUS_MUSIC};

#[derive(Clone, Debug)]
pub struct TsConnectConfig {
    pub host: String,
    pub port: u16,
    pub nick: String,
    pub server_password: Option<String>,
    pub default_channel: Option<String>,
    pub identity_path: PathBuf,
    pub query_host: String,
    pub query_port: u16,
    pub api_key: String,
}

impl TsConnectConfig {
    pub fn from_env(data_dir: &Path) -> Option<Self> {
        let host = std::env::var("TS6_HOST").ok().filter(|s| !s.is_empty())?;
        let port = std::env::var("TS6_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(9987);
        let nick = std::env::var("TS6_NICK")
            .or_else(|_| std::env::var("BOT_NICKNAME"))
            .unwrap_or_else(|_| "Moneypenny".into());
        Some(Self {
            host: host.clone(),
            port,
            nick,
            server_password: std::env::var("TS6_SERVER_PASSWORD")
                .ok()
                .filter(|s| !s.is_empty()),
            default_channel: std::env::var("DEFAULT_CHANNEL").ok().filter(|s| !s.is_empty()),
            identity_path: data_dir.join("ts-identity.txt"),
            query_host: std::env::var("TS6_QUERY_HOST").unwrap_or(host),
            query_port: std::env::var("TS6_QUERY_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(10080),
            api_key: std::env::var("TS6_API_KEY").unwrap_or_default(),
        })
    }
}

pub struct LiveSession {
    tx: broadcast::Sender<TsEvent>,
    /// Held so `tx.send` never fails with "no receivers" before the bot loop subscribes.
    _keep: broadcast::Receiver<TsEvent>,
    client: Mutex<Option<Arc<Client>>>,
    client_id: AtomicI32,
    connected: AtomicBool,
    config: TsConnectConfig,
    query: Option<QueryClient>,
    closing: AtomicBool,
}

impl LiveSession {
    pub fn new(config: TsConnectConfig) -> Self {
        let (tx, keep) = broadcast::channel(256);
        let query = QueryClient::new(&config.query_host, config.query_port, &config.api_key).ok();
        Self {
            tx,
            _keep: keep,
            client: Mutex::new(None),
            client_id: AtomicI32::new(0),
            connected: AtomicBool::new(false),
            config,
            query,
            closing: AtomicBool::new(false),
        }
    }

    pub fn query(&self) -> Option<&QueryClient> {
        self.query.as_ref()
    }

    pub async fn groups_for(&self, clid: i32, fallback: Vec<String>) -> Vec<String> {
        if !fallback.is_empty() {
            return fallback;
        }
        if let Some(q) = &self.query {
            let g = q.groups_for_clid(clid).await;
            if !g.is_empty() {
                return g;
            }
        }
        fallback
    }

    pub async fn connect(&self) -> Result<()> {
        self.closing.store(false, Ordering::SeqCst);
        let identity = load_or_create_identity(&self.config.identity_path)?;
        let addr = format!("{}:{}", self.config.host, self.config.port);
        tracing::info!(addr = %addr, nick = %self.config.nick, "ts connect");
        let mut opts = ClientOptions::default();
        opts.server_password = self.config.server_password.clone();
        opts.default_channel = self.config.default_channel.clone();
        let mut client = Client::new(identity, addr, self.config.nick.clone(), opts);

        let tx = self.tx.clone();
        let connected = Arc::new(AtomicBool::new(false));
        {
            let c = Arc::clone(&connected);
            let tx = tx.clone();
            client.on_connected(Arc::new(move || {
                c.store(true, Ordering::SeqCst);
                let _ = tx.send(TsEvent::Connected);
            }));
        }
        {
            let tx = tx.clone();
            client.on_text_message(Arc::new(move |ev| {
                if let EventMap::TextMessage(m) = ev {
                    tracing::debug!(
                        clid = m.invoker_id,
                        name = %m.invoker_name,
                        body = %m.message,
                        "ts text"
                    );
                    let _ = tx.send(TsEvent::TextMessage {
                        invoker_id: m.invoker_id,
                        invoker_uid: m.invoker_uid.clone(),
                        invoker_name: m.invoker_name.clone(),
                        body: m.message.clone(),
                        invoker_groups: m.invoker_groups.clone(),
                    });
                }
            }));
        }
        {
            let tx = tx.clone();
            client.on_poked(Arc::new(move |ev| {
                if let EventMap::Poked(p) = ev {
                    let _ = tx.send(TsEvent::Poke {
                        invoker_id: p.invoker_id,
                        invoker_uid: p.invoker_uid.clone(),
                        invoker_name: p.invoker_name.clone(),
                        body: p.message.clone(),
                    });
                }
            }));
        }
        {
            let tx = tx.clone();
            client.on_voice_data(Arc::new(move |ev| {
                if let EventMap::VoiceData(v) = ev {
                    let _ = tx.send(TsEvent::VoiceData {
                        client_id: v.client_id,
                        opus: v.data.to_vec(),
                    });
                }
            }));
        }
        {
            let tx = tx.clone();
            client.on_disconnected(Arc::new(move |ev| {
                let reason = format!("{ev:?}");
                let _ = tx.send(TsEvent::Disconnected { reason });
            }));
        }

        tokio::time::timeout(Duration::from_secs(25), client.connect())
            .await
            .map_err(|_| TsError::Message("connect timed out".into()))?
            .map_err(|e| TsError::Message(e.to_string()))?;
        match tokio::time::timeout(Duration::from_secs(15), client.wait_connected(None)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!(error = %e, "wait_connected"),
            Err(_) => tracing::warn!("wait_connected timed out"),
        }
        let clid = client.client_id();
        if clid == 0 && !connected.load(Ordering::SeqCst) {
            return Err(TsError::Message(
                "connect did not reach connected state".into(),
            ));
        }
        self.client_id.store(clid, Ordering::SeqCst);
        self.connected.store(true, Ordering::SeqCst);
        *self.client.lock().await = Some(Arc::new(client));
        tracing::info!(client_id = clid, "ts connected");
        Ok(())
    }

    pub async fn reconnect(&self) -> Result<()> {
        if self.closing.load(Ordering::SeqCst) {
            return Err(TsError::Message("closing".into()));
        }
        if let Some(c) = self.client.lock().await.take() {
            let _ = c.disconnect().await;
        }
        self.connected.store(false, Ordering::SeqCst);
        self.client_id.store(0, Ordering::SeqCst);
        self.connect().await
    }

    pub async fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        if let Some(c) = self.client.lock().await.take() {
            let _ = c.disconnect().await;
        }
        self.connected.store(false, Ordering::SeqCst);
    }

    pub fn client_id(&self) -> i32 {
        self.client_id.load(Ordering::SeqCst)
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    pub fn is_closing(&self) -> bool {
        self.closing.load(Ordering::SeqCst)
    }
}

fn load_or_create_identity(path: &Path) -> Result<tsclient_rs::Identity> {
    if let Ok(s) = std::fs::read_to_string(path) {
        let s = s.trim();
        if !s.is_empty() {
            return tsclient_rs::identityFromString(s)
                .map_err(|e| TsError::Message(e.to_string()));
        }
    }
    tracing::info!("generating TeamSpeak identity (level 8)");
    let id = tsclient_rs::generateIdentity(8);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, id.to_string());
    Ok(id)
}

impl TsSession for LiveSession {
    async fn send_text(&self, target: Target, body: &str) -> Result<()> {
        let guard = self.client.lock().await;
        let client = guard.as_ref().ok_or(TsError::NotConnected)?;
        let (mode, id) = match target {
            Target::Channel => (2, client.channel_id()),
            Target::Client { id } => (1, id as u64),
            Target::Poke { id } => {
                tsclient_rs::poke(client, id, body)
                    .await
                    .map_err(|e| TsError::Message(e.to_string()))?;
                return Ok(());
            }
        };
        tsclient_rs::sendTextMessage(client, mode, id, body)
            .await
            .map_err(|e| TsError::Message(e.to_string()))
    }

    fn subscribe(&self) -> broadcast::Receiver<TsEvent> {
        self.tx.subscribe()
    }

    async fn send_opus(&self, pkt: OpusPacket) -> Result<()> {
        let guard = self.client.lock().await;
        let client = guard.as_ref().ok_or(TsError::NotConnected)?;
        let codec = if pkt.codec == 0 {
            i32::from(CODEC_OPUS_MUSIC)
        } else {
            i32::from(pkt.codec)
        };
        client.send_voice(pkt.data, codec);
        Ok(())
    }
}

impl crate::TsSessionExt for LiveSession {
    fn client_id(&self) -> i32 {
        LiveSession::client_id(self)
    }
    fn is_connected(&self) -> bool {
        LiveSession::is_connected(self)
    }
}
