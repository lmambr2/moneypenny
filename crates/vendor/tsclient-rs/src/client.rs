//! Client lifecycle & connection management — mirrors `teamspeak-js/src/client.ts`

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
use tokio::sync::oneshot;

use crate::command::parse_command;
use crate::commands::{self, CommandTracker};
use crate::crypto::{Crypt, Identity};
use crate::discovery::Resolver;
use crate::events::{build_command_chain, build_event_chain};
use crate::helpers::{is_auto_nickname_match, split_command_rows};
use crate::notifications::{handle_notification, NotificationResult};
use crate::throttle::CommandThrottle;
use crate::transfer::{self, FileTransferTracker, FtNotification};
use crate::transport::{Packet, PacketHandler, PacketSender, PacketType};
pub use crate::types::AbortSignal;
use crate::types::*;
pub use crate::types::ClientStatus;
use crate::Error;

// ---- Internal helpers -----------------------------------------------------------

#[derive(Clone)]
pub(crate) struct ClientInitOptions {
    pub(crate) server_password: String,
    pub(crate) default_channel: String,
    pub(crate) default_channel_password: String,
}

impl From<&ClientOptions> for ClientInitOptions {
    fn from(opts: &ClientOptions) -> Self {
        Self {
            server_password: opts.server_password.clone().unwrap_or_default(),
            default_channel: opts.default_channel.clone().unwrap_or_default(),
            default_channel_password: opts.default_channel_password.clone().unwrap_or_default(),
        }
    }
}

// ---- Event handler storage ------------------------------------------------------

struct EventHandlers {
    text_message: Vec<EventHandler>,
    client_enter: Vec<EventHandler>,
    client_leave: Vec<EventHandler>,
    client_moved: Vec<EventHandler>,
    poked: Vec<EventHandler>,
    voice_data: Vec<EventHandler>,
    connected: Vec<Arc<dyn Fn() + Send + Sync>>,
    disconnected: Vec<EventHandler>,
    kicked: Vec<EventHandler>,
}

impl EventHandlers {
    fn new() -> Self {
        Self {
            text_message: Vec::new(),
            client_enter: Vec::new(),
            client_leave: Vec::new(),
            client_moved: Vec::new(),
            poked: Vec::new(),
            voice_data: Vec::new(),
            connected: Vec::new(),
            disconnected: Vec::new(),
            kicked: Vec::new(),
        }
    }
}

// ---- ClientInner (all private mutable state) ------------------------------------

pub(crate) struct ClientInner {
    pub(crate) crypt: Crypt,
    pub(crate) logger: Arc<dyn Logger>,
    pub(crate) nickname: String,
    pub(crate) clid: i32,
    pub(crate) identity: Identity,
    pub(crate) addr: String,
    pub(crate) client_init_options: ClientInitOptions,
    pub(crate) status: ClientStatus,
    pub(crate) cmd_track: CommandTracker,
    pub(crate) ft_track: FileTransferTracker,
    pub(crate) clients: HashMap<i32, ClientInfo>,
    pub(crate) connected_wakers: Vec<oneshot::Sender<()>>,
    event_handlers: EventHandlers,
    pub(crate) cmd_middlewares: Vec<Box<dyn CommandMiddleware>>,
    pub(crate) event_middlewares: Vec<Box<dyn EventMiddleware>>,
    pub(crate) packet_rx: mpsc::UnboundedReceiver<Packet>,
    pub(crate) close_rx: mpsc::UnboundedReceiver<Option<Error>>,
    pub(crate) close_tx: mpsc::UnboundedSender<Option<Error>>,
    /// Set when error 3329 is received — signals the bg task to perform
    /// a deferred disconnect, matching JS `setImmediate(() => this.disconnect())`.
    pub(crate) pending_disconnect: bool,
}

impl ClientInner {
    fn new(
        crypt: Crypt,
        logger: Arc<dyn Logger>,
        nickname: String,
        identity: Identity,
        addr: String,
        client_init_options: ClientInitOptions,
        cmd_middlewares: Vec<Box<dyn CommandMiddleware>>,
        event_middlewares: Vec<Box<dyn EventMiddleware>>,
        close_tx: mpsc::UnboundedSender<Option<Error>>,
    ) -> Self {
        let (_, packet_rx) = mpsc::unbounded_channel();
        let (_, close_rx) = mpsc::unbounded_channel();
        Self {
            crypt,
            logger,
            nickname,
            clid: 0,
            identity,
            addr,
            client_init_options,
            status: ClientStatus::Disconnected,
            cmd_track: CommandTracker::new(),
            ft_track: FileTransferTracker::new(),
            clients: HashMap::new(),
            connected_wakers: Vec::new(),
            event_handlers: EventHandlers::new(),
            cmd_middlewares,
            event_middlewares,
            packet_rx,
            close_rx,
            close_tx,
            pending_disconnect: false,
        }
    }

    // ---- Packet processing -------------------------------------------------------

    fn process_packet(&mut self, sender: &PacketSender, p: Packet) {
        let p_type = p.type_flagged & 0x0f;
        if p_type == 8 /* Init1 */ {
            match crate::handshake::process_init1(&mut self.crypt, Some(&p.data)) {
                Ok(Some(response)) => {
                    sender.set_crypt(self.crypt.clone());
                    sender.send_packet(PacketType::Init1, response, 0);
                }
                _ => {}
            }
            return;
        }

        if (p_type == 0 /* Voice */ || p_type == 1 /* VoiceWhisper */) && p.data.len() > 5 {
            self.handle_voice_packet(&p.data);
            return;
        }

        if (p_type == 2 /* Command */ || p_type == 3 /* CommandLow */) && !p.data.is_empty() {
            if let Ok(s) = String::from_utf8(p.data) {
                self.handle_command_lines(&s, sender);
            }
        }
    }

    fn handle_voice_packet(&self, payload: &[u8]) {
        if self.event_handlers.voice_data.is_empty() {
            return;
        }

        if payload.len() < 5 {
            return;
        }

        let client_id = u16::from_be_bytes([payload[2], payload[3]]) as i32;
        if client_id == self.clid {
            return;
        }

        let codec = payload[4] as i32;
        let data = payload[5..].to_vec();

        let voice_data = VoiceData {
            client_id,
            codec,
            data: bytes::Bytes::from(data),
        };

        for h in &self.event_handlers.voice_data {
            let h = Arc::clone(h);
            let vd = voice_data.clone();
            tokio::spawn(async move {
                h(Event::VoiceData(vd));
            });
        }
    }

    fn handle_command_lines(&mut self, s: &str, sender: &PacketSender) {
        if s.is_empty() {
            return;
        }
        for line in s.replace('\0', "\n").split('\n') {
            let trimmed = line.trim_end_matches('\r');
            if trimmed.is_empty() {
                continue;
            }
            for row in split_command_rows(trimmed) {
                self.handle_command_str(&row, sender);
            }
        }
    }

    fn handle_command_str(&mut self, s: &str, sender: &PacketSender) {
        let cmd = match parse_command(s) {
            Some(c) => c,
            None => return,
        };

        if cmd.name.starts_with("notify") {
            let result = handle_notification(
                &cmd.name,
                &cmd.params,
                self.clid,
                &mut self.clients,
                &self.nickname,
            );
            self.process_notification_result(result, &cmd.params, sender);
            return;
        }

        match cmd.name.as_str() {
            "clientinitiv" => {
                crate::handshake::handle_handshake_init_iv(self, sender, &cmd.params);
                sender.set_crypt(self.crypt.clone());
            }
            "initivexpand2" => {
                crate::handshake::handle_handshake_expand2(self, sender, &cmd.params);
                sender.set_crypt(self.crypt.clone());
            }
            "initserver" => {
                crate::handshake::handle_init_server(self, sender, &cmd.params);
            }
            "error" => {
                self.handle_error(&cmd.params);
            }
            _ => {
                let params = if cmd.name.contains('=') {
                    let eq_idx = cmd.name.find('=').unwrap();
                    let k = cmd.name[..eq_idx].to_string();
                    let v = cmd.name[eq_idx + 1..].to_string();
                    let mut p = HashMap::new();
                    p.insert(k, v);
                    p.extend(cmd.params);
                    p
                } else {
                    cmd.params
                };
                self.cmd_track.buffer(params);
            }
        }
    }

    fn handle_error(&mut self, params: &HashMap<String, String>) {
        let (err, rc) = commands::parse_server_error(params);
        if rc.is_some() {
            self.cmd_track.resolve(rc.unwrap(), err);
        } else {
            self.cmd_track.discard_buffer();
        }

        let id = params.get("id").map(|s| s.as_str()).unwrap_or("0");
        if id == "3329" {
            // JS: `setImmediate(() => this.disconnect().catch(() => {}))`
            // Defer the disconnect to after process_packet returns and the
            // inner lock is released. The bg task checks this flag.
            self.pending_disconnect = true;
        }
    }

    fn process_notification_result(
        &mut self,
        result: NotificationResult,
        _params: &HashMap<String, String>,
        sender: &PacketSender,
    ) {
        match result {
            NotificationResult::ClientEnter { info } => {
                if info.id != 0 && is_auto_nickname_match(&self.nickname, &info.nickname) {
                    self.clid = info.id;
                    sender.set_client_id(info.id);
                    self.cmd_track.signal_welcome_complete();
                }
                self.dispatch_event(Event::ClientEnter(info));
            }
            NotificationResult::ClientLeave { event, is_self } => {
                self.dispatch_event(Event::ClientLeave(event.clone()));
                if is_self && (event.reason_id == 4 || event.reason_id == 5) {
                    for h in &self.event_handlers.kicked {
                        let h = Arc::clone(h);
                        let msg = event.reason_msg.clone();
                        tokio::spawn(async move { h(Event::Kicked(msg)); });
                    }
                }
            }
            NotificationResult::ClientMoved { event } => {
                self.dispatch_event(Event::ClientMoved(event));
            }
            NotificationResult::TextMessage { message } => {
                self.dispatch_event(Event::TextMessage(message));
            }
            NotificationResult::Poked { event } => {
                self.dispatch_event(Event::Poked(event));
            }
            NotificationResult::StartUpload { info } => {
                self.ft_track.notify(info.client_file_transfer_id, FtNotification::Upload(info));
            }
            NotificationResult::StartDownload { info } => {
                self.ft_track.notify(info.client_file_transfer_id, FtNotification::Download(info));
            }
            NotificationResult::FileTransferStatus { info } => {
                self.ft_track.notify(info.client_file_transfer_id, FtNotification::Status(info));
            }
            NotificationResult::Unknown => {}
        }
    }

    fn dispatch_event(&mut self, event: Event) {
        let dispatched = Arc::new(Mutex::new(None::<Event>));
        let base: EventHandler = {
            let d = Arc::clone(&dispatched);
            Arc::new(move |ev: Event| {
                *d.lock().unwrap() = Some(ev);
            })
        };
        let chain = build_event_chain(&self.event_middlewares, base);
        chain(event);
        if let Some(evt) = dispatched.lock().unwrap().take() {
            match evt {
                Event::TextMessage(msg) => {
                    for h in &self.event_handlers.text_message {
                        let h = Arc::clone(h);
                        let m = msg.clone();
                        tokio::spawn(async move { h(Event::TextMessage(m)); });
                    }
                }
                Event::ClientEnter(info) => {
                    for h in &self.event_handlers.client_enter {
                        let h = Arc::clone(h);
                        let i = info.clone();
                        tokio::spawn(async move { h(Event::ClientEnter(i)); });
                    }
                }
                Event::ClientLeave(evt) => {
                    for h in &self.event_handlers.client_leave {
                        let h = Arc::clone(h);
                        let e = evt.clone();
                        tokio::spawn(async move { h(Event::ClientLeave(e)); });
                    }
                }
                Event::ClientMoved(evt) => {
                    for h in &self.event_handlers.client_moved {
                        let h = Arc::clone(h);
                        let e = evt.clone();
                        tokio::spawn(async move { h(Event::ClientMoved(e)); });
                    }
                }
                Event::Poked(evt) => {
                    for h in &self.event_handlers.poked {
                        let h = Arc::clone(h);
                        let e = evt.clone();
                        tokio::spawn(async move { h(Event::Poked(e)); });
                    }
                }
                Event::VoiceData(data) => {
                    for h in &self.event_handlers.voice_data {
                        let h = Arc::clone(h);
                        let d = data.clone();
                        tokio::spawn(async move { h(Event::VoiceData(d)); });
                    }
                }
                Event::Connected => {
                    for h in &self.event_handlers.connected {
                        let h = Arc::clone(h);
                        tokio::spawn(async move { h(); });
                    }
                }
                Event::Disconnected(err) => {
                    for h in &self.event_handlers.disconnected {
                        let h = Arc::clone(h);
                        let e = err.clone();
                        tokio::spawn(async move { h(Event::Disconnected(e)); });
                    }
                }
                Event::Kicked(msg) => {
                    for h in &self.event_handlers.kicked {
                        let h = Arc::clone(h);
                        let m = msg.clone();
                        tokio::spawn(async move { h(Event::Kicked(m)); });
                    }
                }
            }
        }
    }

    fn handle_connection_closed(&mut self, err: Option<Error>) {
        if self.status == ClientStatus::Disconnected {
            return;
        }
        self.status = ClientStatus::Disconnected;
        let handlers = std::mem::take(&mut self.event_handlers.disconnected);
        for h in handlers {
            let e = err.clone();
            tokio::spawn(async move { h(Event::Disconnected(e)); });
        }
    }

    pub(crate) fn mark_connected(&mut self) {
        self.status = ClientStatus::Connected;
        for waker in self.connected_wakers.drain(..) {
            let _ = waker.send(());
        }
        let handlers = std::mem::take(&mut self.event_handlers.connected);
        for h in handlers {
            tokio::spawn(async move { h(); });
        }
    }
}

// ---- Client --------------------------------------------------------------------

pub struct Client {
    pub handler: Mutex<PacketHandler>,
    pub logger: Arc<dyn Logger>,
    pub nickname: String,
    resolver: Box<dyn AddrResolver>,
    throttle: tokio::sync::Mutex<CommandThrottle>,
    final_cmd_handler: Mutex<CommandHandler>,
    inner: Arc<Mutex<ClientInner>>,
    _bg_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Client {
    pub fn new(
        identity: Identity,
        addr: String,
        nickname: String,
        options: ClientOptions,
    ) -> Self {
        let client_init_options = ClientInitOptions::from(&options);
        let logger: Arc<dyn Logger> = options.logger;
        let resolver: Box<dyn AddrResolver> = options.resolver.unwrap_or_else(|| Box::new(Resolver::new()));
        let cmd_middlewares = options.command_middleware;
        let event_middlewares = options.event_middleware;

        let crypt = Crypt::new(identity.clone());
        let handler = PacketHandler::new(crypt.clone(), Arc::clone(&logger));
        let packet_sender = handler.create_packet_sender();

        let final_cmd_handler = Self::build_cmd_handler_simple(&cmd_middlewares, &packet_sender);

        let (close_tx, _close_rx_dummy) = mpsc::unbounded_channel();
        let inner = Arc::new(Mutex::new(ClientInner::new(
            crypt,
            Arc::clone(&logger),
            nickname.clone(),
            identity,
            addr,
            client_init_options,
            cmd_middlewares,
            event_middlewares,
            close_tx,
        )));

        Self {
            handler: Mutex::new(handler),
            logger,
            nickname,
            resolver,
            throttle: tokio::sync::Mutex::new(CommandThrottle::new()),
            final_cmd_handler: Mutex::new(final_cmd_handler),
            inner,
            _bg_task: Mutex::new(None),
        }
    }

    fn build_cmd_handler_simple(
        middlewares: &[Box<dyn CommandMiddleware>],
        sender: &PacketSender,
    ) -> CommandHandler {
        let sender = sender.create_command_sender();
        let base: CommandHandler = Arc::new(move |cmd: String| {
            let sender = Arc::clone(&sender);
            Box::pin(async move {
                sender(cmd.into_bytes());
                Ok(())
            }) as Pin<Box<dyn Future<Output = Result<(), Error>> + Send>>
        });
        build_command_chain(middlewares, base)
    }

    // ---- Status ---------------------------------------------------------------

    pub fn status(&self) -> ClientStatus {
        self.inner.lock().unwrap().status
    }

    pub fn client_id(&self) -> i32 {
        self.inner.lock().unwrap().clid
    }

    pub fn channel_id(&self) -> u64 {
        let inner = self.inner.lock().unwrap();
        inner
            .clients
            .get(&inner.clid)
            .map(|info| info.channel_id)
            .unwrap_or(0)
    }

    // ---- Connection -----------------------------------------------------------

    pub async fn connect(&mut self) -> Result<(), Error> {
        {
            let inner = self.inner.lock().unwrap();
            if inner.status != ClientStatus::Disconnected {
                return Err(Error::AlreadyConnected);
            }
        }

        self.reset_for_connect();

        {
            let mut inner = self.inner.lock().unwrap();
            inner.status = ClientStatus::Connecting;
        }

        let target_addr = {
            let inner = self.inner.lock().unwrap();
            resolve_addr_impl(&inner.addr, &*self.resolver).await
        };
        self.logger.info(&format!("connecting to server: {target_addr}"), &[]);
        {
            let handler = self.handler.lock().unwrap();
            handler.connect(&target_addr).await?;
        }

        // Spawn background packet processing task
        let inner = Arc::clone(&self.inner);
        let sender = {
            let handler = self.handler.lock().unwrap();
            handler.create_packet_sender()
        };
        let handle = tokio::spawn(async move {
            let (mut packet_rx, mut close_rx) = {
                let mut i = inner.lock().unwrap();
                let (_, pr) = mpsc::unbounded_channel();
                let (_, cr) = mpsc::unbounded_channel();
                let packet_rx = std::mem::replace(&mut i.packet_rx, pr);
                let close_rx = std::mem::replace(&mut i.close_rx, cr);
                (packet_rx, close_rx)
            };

            loop {
                tokio::select! {
                    Some(packet) = packet_rx.recv() => {
                        let pending = {
                            let mut i = inner.lock().unwrap();
                            i.process_packet(&sender, packet);
                            if i.pending_disconnect {
                                i.pending_disconnect = false;
                                true
                            } else {
                                false
                            }
                        };
                        if pending {
                            // Deferred disconnect — mirrors JS `disconnect()`:
                            // 1. Check if already disconnected → skip
                            // 2. Set status to Disconnected
                            // 3. If was Connected, send `clientdisconnect` (best-effort)
                            // 4. Close handler
                            // 5. Call disconnected handlers with None
                            let (was_connected, handlers) = {
                                let mut i = inner.lock().unwrap();
                                if i.status == ClientStatus::Disconnected {
                                    break;
                                }
                                let was_connected = i.status == ClientStatus::Connected;
                                i.status = ClientStatus::Disconnected;
                                let handlers = std::mem::take(&mut i.event_handlers.disconnected);
                                (was_connected, handlers)
                            };
                            if was_connected {
                                let cmd_sender = sender.create_command_sender();
                                cmd_sender(b"clientdisconnect reasonmsg=Shutdown".to_vec());
                            }
                            sender.close();
                            for h in handlers {
                                tokio::spawn(async move {
                                    h(Event::Disconnected(None));
                                });
                            }
                            break;
                        }
                    }
                    Some(err) = close_rx.recv() => {
                        let mut i = inner.lock().unwrap();
                        i.handle_connection_closed(err);
                        break;
                    }
                    else => break,
                }
            }
        });
        *self._bg_task.lock().unwrap() = Some(handle);

        Ok(())
    }

    pub async fn disconnect(&self) -> Result<(), Error> {
        let was_connected = {
            let mut inner = self.inner.lock().unwrap();
            if inner.status == ClientStatus::Disconnected {
                return Ok(());
            }
            let was_connected = inner.status == ClientStatus::Connected;
            inner.status = ClientStatus::Disconnected;
            was_connected
        };

        self.logger.info("disconnecting from server", &[]);

        if was_connected {
            let _ = self.exec_command("clientdisconnect reasonmsg=Shutdown", 1000).await;
        }

        self.handler.lock().unwrap().close();
        let handler_handle = self.handler.lock().unwrap().take_handle();
        if let Some(h) = handler_handle {
            let _ = h.await;
        }

        if let Some(handle) = self._bg_task.lock().unwrap().take() {
            let _ = handle.await;
        }

        let handlers = {
            let mut inner = self.inner.lock().unwrap();
            std::mem::take(&mut inner.event_handlers.disconnected)
        };
        for h in handlers {
            h(Event::Disconnected(None));
        }

        Ok(())
    }

    pub async fn wait_connected(&self, signal: Option<&AbortSignal>) -> Result<(), Error> {
        let mut rx = {
            let mut inner = self.inner.lock().unwrap();
            if inner.status == ClientStatus::Connected {
                return Ok(());
            }
            let (tx, rx) = oneshot::channel();
            inner.connected_wakers.push(tx);
            rx
        };
        match signal {
            Some(sig) => {
                let canceled = Error::Teamspeak("connection cancelled".into());
                let aborted = Error::Teamspeak("aborted".into());
                tokio::select! {
                    r = &mut rx => r.map_err(|_| canceled)?,
                    _ = sig.wait_for_abort() => return Err(aborted),
                }
                Ok(())
            }
            None => {
                rx.await.map_err(|_| Error::Teamspeak("connection cancelled".into()))?;
                Ok(())
            }
        }
    }

    // ---- Commands -------------------------------------------------------------

    pub async fn send_command_no_wait(&self, cmd: &str) -> Result<(), Error> {
        self.throttle.lock().await.wait(None).await?;
        let handler = self.final_cmd_handler.lock().unwrap().clone();
        handler(cmd.to_string()).await
    }

    pub async fn exec_command(&self, cmd: &str, timeout_ms: u64) -> Result<(), Error> {
        self.exec_command_with_response(cmd, timeout_ms).await?;
        Ok(())
    }

    pub async fn exec_command_with_response(
        &self,
        cmd: &str,
        timeout_ms: u64,
    ) -> Result<Vec<HashMap<String, String>>, Error> {
        let (rc, mut rx) = {
            let mut inner = self.inner.lock().unwrap();
            inner.cmd_track.register()
        };
        let with_rc = commands::append_return_code(cmd, rc);

        self.throttle.lock().await.wait(None).await?;

        let handler = self.final_cmd_handler.lock().unwrap().clone();
        if let Err(err) = handler(with_rc).await {
            let mut inner = self.inner.lock().unwrap();
            inner.cmd_track.unregister(rc);
            return Err(err);
        }

        let result = tokio::time::timeout(
            std::time::Duration::from_millis(timeout_ms),
            &mut rx,
        )
        .await
        .map_err(|_| Error::CommandTimeout { command: cmd.to_string() })?
        .map_err(|_| Error::Teamspeak("command channel closed".into()))?;

        let mut inner = self.inner.lock().unwrap();
        inner.cmd_track.unregister(rc);

        if let Some(err) = result.err {
            return Err(err);
        }
        Ok(result.data)
    }

    // ---- Events ---------------------------------------------------------------

    pub fn on_text_message(&self, handler: EventHandler) -> &Self {
        self.inner.lock().unwrap().event_handlers.text_message.push(handler);
        self
    }

    pub fn on_client_enter(&self, handler: EventHandler) -> &Self {
        self.inner.lock().unwrap().event_handlers.client_enter.push(handler);
        self
    }

    pub fn on_client_leave(&self, handler: EventHandler) -> &Self {
        self.inner.lock().unwrap().event_handlers.client_leave.push(handler);
        self
    }

    pub fn on_client_moved(&self, handler: EventHandler) -> &Self {
        self.inner.lock().unwrap().event_handlers.client_moved.push(handler);
        self
    }

    pub fn on_poked(&self, handler: EventHandler) -> &Self {
        self.inner.lock().unwrap().event_handlers.poked.push(handler);
        self
    }

    pub fn on_voice_data(&self, handler: EventHandler) -> &Self {
        self.inner.lock().unwrap().event_handlers.voice_data.push(handler);
        self
    }

    pub fn on_connected(&self, handler: Arc<dyn Fn() + Send + Sync>) -> &Self {
        self.inner.lock().unwrap().event_handlers.connected.push(handler);
        self
    }

    pub fn on_disconnected(&self, handler: EventHandler) -> &Self {
        self.inner.lock().unwrap().event_handlers.disconnected.push(handler);
        self
    }

    pub fn on_kicked(&self, handler: EventHandler) -> &Self {
        self.inner.lock().unwrap().event_handlers.kicked.push(handler);
        self
    }

    pub fn use_command_middleware(&self, mw: Vec<Box<dyn CommandMiddleware>>) -> &Self {
        let sender = self.handler.lock().unwrap().create_packet_sender();
        let new_handler = {
            let mut inner = self.inner.lock().unwrap();
            inner.cmd_middlewares.extend(mw);
            Self::build_cmd_handler_simple(&inner.cmd_middlewares, &sender)
        };
        *self.final_cmd_handler.lock().unwrap() = new_handler;
        self
    }

    pub fn use_event_middleware(&self, mw: Vec<Box<dyn EventMiddleware>>) -> &Self {
        self.inner.lock().unwrap().event_middlewares.extend(mw);
        self
    }

    // ---- API shorthand --------------------------------------------------------

    pub fn send_voice(&self, data: Vec<u8>, codec: i32) {
        self.handler.lock().unwrap().send_voice_packet(data, codec);
    }

    // ---- File Transfer --------------------------------------------------------

    pub async fn file_transfer_init_upload(
        &self,
        channel_id: u64,
        path: &str,
        password: &str,
        size: u64,
        overwrite: bool,
    ) -> Result<FileUploadInfo, Error> {
        let (cftid, mut ft_rx) = {
            let mut inner = self.inner.lock().unwrap();
            inner.ft_track.register()
        };
        let cmd = transfer::build_ft_init_upload(channel_id, path, password, size, cftid, overwrite);

        if let Err(err) = self.exec_command(&cmd, 10_000).await {
            let mut inner = self.inner.lock().unwrap();
            inner.ft_track.unregister(cftid);
            return Err(err);
        }

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            &mut ft_rx,
        )
        .await
        .map_err(|_| Error::FileTransferTimeout)?
        .map_err(|_| Error::Teamspeak("file transfer channel closed".into()))?;

        let mut inner = self.inner.lock().unwrap();
        inner.ft_track.unregister(cftid);

        match result {
            FtNotification::Upload(info) => Ok(info),
            FtNotification::Download(_) => Err(Error::FileTransfer("unexpected download response".into())),
            FtNotification::Status(st) => {
                Err(Error::FileTransfer(format!("{} (status={})", st.message, st.status)))
            }
        }
    }

    pub async fn file_transfer_init_download(
        &self,
        channel_id: u64,
        path: &str,
        password: &str,
    ) -> Result<FileDownloadInfo, Error> {
        let (cftid, mut ft_rx) = {
            let mut inner = self.inner.lock().unwrap();
            inner.ft_track.register()
        };
        let cmd = transfer::build_ft_init_download(channel_id, path, password, cftid);

        if let Err(err) = self.exec_command(&cmd, 10_000).await {
            let mut inner = self.inner.lock().unwrap();
            inner.ft_track.unregister(cftid);
            return Err(err);
        }

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            &mut ft_rx,
        )
        .await
        .map_err(|_| Error::FileTransferTimeout)?
        .map_err(|_| Error::Teamspeak("file transfer channel closed".into()))?;

        let mut inner = self.inner.lock().unwrap();
        inner.ft_track.unregister(cftid);

        match result {
            FtNotification::Download(info) => Ok(info),
            FtNotification::Upload(_) => Err(Error::FileTransfer("unexpected upload response".into())),
            FtNotification::Status(st) => {
                Err(Error::FileTransfer(format!("{} (status={})", st.message, st.status)))
            }
        }
    }

    pub async fn upload_file_data<R: tokio::io::AsyncRead + Unpin>(
        &self,
        host: &str,
        info: &FileUploadInfo,
        data: R,
    ) -> Result<(), Error> {
        transfer::upload_file_data(host, info, data).await
    }

    pub async fn download_file_data<W: tokio::io::AsyncWrite + Unpin>(
        &self,
        host: &str,
        info: &FileDownloadInfo,
        dest: W,
    ) -> Result<(), Error> {
        transfer::download_file_data(host, info, dest).await
    }

    // ---- Internal (package-visible) -------------------------------------------

    /// Called by handshake when the server acknowledges our connection.
    pub fn mark_connected(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.status = ClientStatus::Connected;
        for waker in inner.connected_wakers.drain(..) {
            let _ = waker.send(());
        }
        let handlers = std::mem::take(&mut inner.event_handlers.connected);
        drop(inner);
        for h in handlers {
            tokio::spawn(async move { h(); });
        }
    }

    // ---- Private --------------------------------------------------------------

    fn reset_for_connect(&mut self) {
        self.handler.lock().unwrap().close();

        let new_crypt = {
            let inner = self.inner.lock().unwrap();
            Crypt::new(inner.identity.clone())
        };

        // Replace the PacketHandler entirely, matching JS resetForConnect
        *self.handler.lock().unwrap() = PacketHandler::new(new_crypt.clone(), Arc::clone(&self.logger));

        let (packet_tx, packet_rx) = mpsc::unbounded_channel();
        let (close_tx, close_rx) = mpsc::unbounded_channel();

        self.handler.lock().unwrap().set_on_packet(Box::new(move |p: Packet| {
            let _ = packet_tx.send(p);
        }));
        let close_tx_for_inner = close_tx.clone();
        self.handler.lock().unwrap().set_on_close(Box::new(move |err: Option<Error>| {
            let _ = close_tx.send(err);
        }));

        let sender = self.handler.lock().unwrap().create_packet_sender();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.crypt = new_crypt;
            inner.cmd_track.reset();
            inner.ft_track.reset();
            inner.clients.clear();
            inner.clid = 0;
            inner.packet_rx = packet_rx;
            inner.close_rx = close_rx;
            inner.close_tx = close_tx_for_inner;
        }
        *self.final_cmd_handler.lock().unwrap() = Self::build_cmd_handler_simple(
            &self.inner.lock().unwrap().cmd_middlewares,
            &sender,
        );
    }
}

// ---- Free functions -----------------------------------------------------------

async fn resolve_addr_impl(addr: &str, resolver: &dyn AddrResolver) -> String {
    let addr_with_port = if addr.contains(':') {
        addr.to_string()
    } else {
        format!("{}:9987", addr)
    };
    match resolver.resolve(addr, None).await {
        Ok(addrs) => addrs.first().map(|a| a.addr.clone()).unwrap_or(addr_with_port),
        Err(_) => addr_with_port,
    }
}
