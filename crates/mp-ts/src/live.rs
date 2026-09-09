// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! Option A live session: tsclient-rs + HTTP Query groups.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{broadcast, Mutex};
use tsclient_rs::{self, Client, ClientOptions, EventMap};

use crate::query::QueryClient;
use crate::{
    OpusPacket, PresenceClient, Result, Target, TsError, TsEvent, TsSession, CODEC_OPUS_MUSIC,
};

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
    channel_id: AtomicU64,
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
            channel_id: AtomicU64::new(0),
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
                        codec: v.codec as u8,
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
        match tokio::time::timeout(Duration::from_secs(25), client.wait_connected(None)).await {
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
        self.channel_id.store(client.channel_id(), Ordering::SeqCst);
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
        self.channel_id.store(0, Ordering::SeqCst);
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

    pub fn channel_id(&self) -> u64 {
        self.channel_id.load(Ordering::SeqCst)
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    async fn client_arc(&self) -> Option<Arc<Client>> {
        self.client.lock().await.as_ref().cloned()
    }

    pub async fn list_clients(&self) -> Vec<PresenceClient> {
        let Some(c) = self.client_arc().await else {
            return Vec::new();
        };
        match c.exec_command_with_response("clientlist", 4000).await {
            Ok(rows) => rows.into_iter().filter_map(row_to_presence).collect(),
            Err(e) => {
                tracing::debug!(error = %e, "clientlist failed");
                Vec::new()
            }
        }
    }

    pub async fn join_channel(&self, cid: u64) -> bool {
        if cid == 0 {
            return false;
        }
        if self.channel_id() == cid {
            return true;
        }
        let clid = self.client_id();
        let Some(c) = self.client_arc().await else {
            return false;
        };
        let cmd = if clid > 0 {
            format!("clientmove clid={clid} cid={cid}")
        } else {
            format!("clientmove cid={cid}")
        };
        match c.exec_command(&cmd, 4000).await {
            Ok(()) => {
                self.channel_id.store(cid, Ordering::SeqCst);
                true
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("770") || msg.to_ascii_lowercase().contains("already") {
                    self.channel_id.store(cid, Ordering::SeqCst);
                    return true;
                }
                tracing::debug!(error = %msg, cid, "join_channel failed");
                false
            }
        }
    }

    pub async fn resolve_channel_id_by_name(&self, name: &str) -> Option<u64> {
        let q = name.trim();
        if q.is_empty() {
            return None;
        }
        if let Some(qc) = self.query.as_ref() {
            if let Ok(ch) = qc.resolve_channel(q).await {
                return Some(ch.cid);
            }
        }
        let c = self.client_arc().await?;
        let rows = c.exec_command_with_response("channellist", 4000).await.ok()?;
        let lower = q.to_ascii_lowercase();
        let mut start: Option<u64> = None;
        let mut contains: Option<u64> = None;
        for row in rows {
            let cid = row
                .get("cid")
                .or_else(|| row.get("channel_id"))
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            let n = row
                .get("channel_name")
                .or_else(|| row.get("name"))
                .cloned()
                .unwrap_or_default();
            if n.eq_ignore_ascii_case(q) {
                return Some(cid);
            }
            let nl = n.to_ascii_lowercase();
            if start.is_none() && nl.starts_with(&lower) {
                start = Some(cid);
            } else if contains.is_none() && nl.contains(&lower) {
                contains = Some(cid);
            }
        }
        start.or(contains)
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
        let client = self.client_arc().await.ok_or(TsError::NotConnected)?;
        let (mode, id) = match target {
            Target::Channel => (2, client.channel_id()),
            Target::Client { id } => (1, id as u64),
            Target::Poke { id } => {
                tsclient_rs::poke(&client, id, body)
                    .await
                    .map_err(|e| TsError::Message(e.to_string()))?;
                return Ok(());
            }
        };
        tsclient_rs::sendTextMessage(&client, mode, id, body)
            .await
            .map_err(|e| TsError::Message(e.to_string()))
    }

    fn subscribe(&self) -> broadcast::Receiver<TsEvent> {
        self.tx.subscribe()
    }

    async fn send_opus(&self, pkt: OpusPacket) -> Result<()> {
        let client = self.client_arc().await.ok_or(TsError::NotConnected)?;
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
    fn channel_id(&self) -> u64 {
        LiveSession::channel_id(self)
    }
    async fn list_clients(&self) -> Vec<PresenceClient> {
        LiveSession::list_clients(self).await
    }
    async fn join_channel(&self, cid: u64) -> bool {
        LiveSession::join_channel(self, cid).await
    }
    async fn resolve_channel_id_by_name(&self, name: &str) -> Option<u64> {
        LiveSession::resolve_channel_id_by_name(self, name).await
    }
}

fn row_to_presence(row: std::collections::HashMap<String, String>) -> Option<PresenceClient> {
    let id = row
        .get("clid")
        .or_else(|| row.get("client_id"))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if id == 0 {
        return None;
    }
    let channel_id = row
        .get("cid")
        .or_else(|| row.get("client_channel_id"))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let client_type = row
        .get("client_type")
        .or_else(|| row.get("type"))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Some(PresenceClient {
        id,
        channel_id,
        client_type,
    })
}
