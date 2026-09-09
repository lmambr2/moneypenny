use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use bytes::Bytes;

use crate::errors::Error;

// ---- Branded primitive types -------------------------------------------------

#[derive(Debug, Clone)]
pub struct EscapedString(pub String);

/// Reason code for [`client_kick`](crate::clientKick).
///
/// - `Channel` — remove the client from the current channel only (reasonid=4).
/// - `Server` — kick the client from the entire server (reasonid=5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KickReason {
    Channel = 4,
    Server = 5,
}

impl From<KickReason> for i32 {
    fn from(r: KickReason) -> Self {
        r as i32
    }
}

// ---- Event data structs ------------------------------------------------------

#[derive(Debug, Clone)]
pub struct TextMessage {
    pub invoker_name: String,
    pub invoker_uid: String,
    pub message: String,
    pub invoker_groups: Vec<String>,
    pub target_mode: i32,
    pub target_id: u64,
    pub invoker_id: i32,
}

#[derive(Debug, Clone)]
pub struct ClientMovedEvent {
    pub invoker_name: String,
    pub invoker_uid: String,
    pub target_channel_id: u64,
    pub reason_id: i32,
    pub id: i32,
    pub invoker_id: i32,
}

#[derive(Debug, Clone)]
pub struct ClientLeftViewEvent {
    pub reason_msg: String,
    pub reason_id: i32,
    pub id: i32,
    pub target_id: i32,
}

#[derive(Debug, Clone)]
pub struct ClientInfo {
    pub nickname: String,
    pub uid: String,
    pub server_groups: Vec<String>,
    pub channel_id: u64,
    pub r#type: i32,
    pub id: i32,
}

#[derive(Debug, Clone)]
pub struct ChannelInfo {
    pub name: String,
    pub description: String,
    pub id: u64,
    pub parent_id: u64,
}

#[derive(Debug, Clone)]
pub struct FileUploadInfo {
    pub file_transfer_key: String,
    pub seek_position: u64,
    pub client_file_transfer_id: i32,
    pub server_file_transfer_id: i32,
    pub port: i32,
}

#[derive(Debug, Clone)]
pub struct FileDownloadInfo {
    pub file_transfer_key: String,
    pub size: u64,
    pub client_file_transfer_id: i32,
    pub server_file_transfer_id: i32,
    pub port: i32,
}

#[derive(Debug, Clone)]
pub struct FileTransferStatusInfo {
    pub message: String,
    pub status: i32,
    pub client_file_transfer_id: i32,
}

#[derive(Debug, Clone)]
pub struct PokeEvent {
    pub invoker_name: String,
    pub invoker_uid: String,
    pub invoker_id: i32,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct VoiceData {
    pub client_id: i32,
    pub codec: i32,
    pub data: Bytes,
}

// ---- Event enum (replaces TS EventMap mapped type) --------------------------

#[derive(Debug, Clone)]
pub enum Event {
    TextMessage(TextMessage),
    ClientEnter(ClientInfo),
    ClientLeave(ClientLeftViewEvent),
    ClientMoved(ClientMovedEvent),
    Poked(PokeEvent),
    VoiceData(VoiceData),
    Connected,
    Disconnected(Option<Error>),
    Kicked(String),
}

// ---- Client state -----------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct ClientState {
    pub status: ClientStatus,
    pub clid: i32,
}

// ---- Client status -----------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientStatus {
    Disconnected = 0,
    Connecting = 1,
    Connected = 2,
}

// ---- Middleware types --------------------------------------------------------

pub type CommandHandler =
    Arc<dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<(), Error>> + Send>> + Send + Sync>;

pub trait CommandMiddleware: Send + Sync {
    fn wrap(&self, next: CommandHandler) -> CommandHandler;
}

pub type EventHandler = Arc<dyn Fn(Event) + Send + Sync>;

pub trait EventMiddleware: Send + Sync {
    fn wrap(&self, next: EventHandler) -> EventHandler;
}

// ---- Logger ------------------------------------------------------------------

pub trait Logger: Send + Sync {
    fn debug(&self, msg: &str, args: &[&dyn std::fmt::Display]);
    fn info(&self, msg: &str, args: &[&dyn std::fmt::Display]);
    fn warn(&self, msg: &str, args: &[&dyn std::fmt::Display]);
    fn error(&self, msg: &str, args: &[&dyn std::fmt::Display]);
}

pub struct NoopLogger;

impl Logger for NoopLogger {
    fn debug(&self, _msg: &str, _args: &[&dyn std::fmt::Display]) {}
    fn info(&self, _msg: &str, _args: &[&dyn std::fmt::Display]) {}
    fn warn(&self, _msg: &str, _args: &[&dyn std::fmt::Display]) {}
    fn error(&self, _msg: &str, _args: &[&dyn std::fmt::Display]) {}
}

pub struct ConsoleLogger;

impl Logger for ConsoleLogger {
    fn debug(&self, msg: &str, _args: &[&dyn std::fmt::Display]) {
        tracing::debug!("{msg}");
    }
    fn info(&self, msg: &str, _args: &[&dyn std::fmt::Display]) {
        tracing::info!("{msg}");
    }
    fn warn(&self, msg: &str, _args: &[&dyn std::fmt::Display]) {
        tracing::warn!("{msg}");
    }
    fn error(&self, msg: &str, _args: &[&dyn std::fmt::Display]) {
        tracing::error!("{msg}");
    }
}

// ---- Resolved address (from discovery) --------------------------------------

#[derive(Debug, Clone)]
pub struct ResolvedAddr {
    pub addr: String,
    pub source: String,
    pub expiry: std::time::Instant,
}

// ---- AbortSignal (TS AbortSignal equivalent) --------------------------------

#[derive(Clone)]
pub struct AbortSignal {
    tx: tokio::sync::watch::Sender<bool>,
    rx: tokio::sync::watch::Receiver<bool>,
}

impl AbortSignal {
    pub fn new() -> Self {
        let (tx, rx) = tokio::sync::watch::channel(false);
        Self { tx, rx }
    }

    pub fn is_aborted(&self) -> bool {
        *self.rx.borrow()
    }

    pub async fn wait_for_abort(&self) {
        let mut rx = self.rx.clone();
        if *rx.borrow() {
            return;
        }
        let _ = rx.changed().await;
    }

    pub fn abort(&self) {
        let _ = self.tx.send(true);
    }
}

// ---- AddrResolver -----------------------------------------------------------

#[async_trait::async_trait]
pub trait AddrResolver: Send + Sync {
    async fn resolve(&self, addr: &str, signal: Option<&AbortSignal>) -> Result<Vec<ResolvedAddr>, Error>;
}

// ---- ClientOptions ----------------------------------------------------------

pub struct ClientOptions {
    pub logger: Arc<dyn Logger>,
    pub resolver: Option<Box<dyn AddrResolver>>,
    pub command_middleware: Vec<Box<dyn CommandMiddleware>>,
    pub event_middleware: Vec<Box<dyn EventMiddleware>>,
    pub server_password: Option<String>,
    pub default_channel: Option<String>,
    pub default_channel_password: Option<String>,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            logger: Arc::new(NoopLogger),
            resolver: None,
            command_middleware: Vec::new(),
            event_middleware: Vec::new(),
            server_password: None,
            default_channel: None,
            default_channel_password: None,
        }
    }
}
