use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::net::UdpSocket;
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tokio::sync::watch;

use crate::crypto::Crypt;
use crate::handshake::process_init1;
use crate::types::Logger;
use crate::Error;

use super::generation_window::GenerationWindow;
use super::packet::{
    build_c2s_header, is_unencrypted, packet_flags, packet_type, Packet, PacketFlags, PacketType,
};
use super::quicklz::Qlz;

const MAX_OUT_PACKET_SIZE: usize = 500;
const RECEIVE_PACKET_WINDOW_SIZE: u32 = 1024;
const PING_INTERVAL_MS: u64 = 5000;
const PACKET_TIMEOUT_MS: u64 = 60000;
const MAX_RETRY_INTERVAL_MS: u64 = 1000;
const HEADER_SIZE: usize = 5;
const TAG_SIZE: usize = 8;
const VOICE_HEADER_SIZE: usize = 3;
const RESEND_BASE_INTERVAL_MS: u64 = 500;
const RESEND_LOOP_INTERVAL_MS: u64 = 100;

pub type OnPacket = Box<dyn FnMut(Packet) + Send>;
pub type OnClose = Box<dyn FnMut(Option<Error>) + Send>;

struct ResendPacket {
    packet: Packet,
    first_send: Instant,
    last_send: Instant,
    retry_count: u32,
    next_interval: u64,
}

struct HandlerCore {
    crypt: Crypt,
    client_id: u16,
    closed: bool,
    last_message_received: Instant,
    packet_counter: [u16; 9],
    generation_counter: [u32; 9],
    recv_window_command: GenerationWindow,
    recv_window_command_low: GenerationWindow,
    send_window_command: GenerationWindow,
    send_window_command_low: GenerationWindow,
    command_queue: HashMap<u16, Packet>,
    command_low_queue: HashMap<u16, Packet>,
    ack_manager: HashMap<i64, ResendPacket>,
    init_packet_check: Option<ResendPacket>,
    next_command_id: u16,
    next_command_low_id: u16,
    pending_sends: Vec<Vec<u8>>,
    logger: Arc<dyn Logger>,
}

impl HandlerCore {
    fn build_and_track_packet(
        &mut self,
        p_type: PacketType,
        data: Vec<u8>,
        flags: u8,
        dummy: bool,
    ) -> Vec<u8> {
        let flags = apply_protocol_flags(p_type, flags);

        let p_id = self.packet_counter[p_type as usize];
        let p_gen = self.generation_counter[p_type as usize];

        if p_type != PacketType::Init1 {
            // wrapping_add: debug builds panic on u16 overflow for `+`.
            self.packet_counter[p_type as usize] = p_id.wrapping_add(1);
            if self.packet_counter[p_type as usize] == 0 {
                self.generation_counter[p_type as usize] =
                    self.generation_counter[p_type as usize].wrapping_add(1);
            }
        }

        let p = Packet {
            type_flagged: (p_type as u8) | flags,
            id: p_id,
            client_id: self.client_id,
            generation_id: p_gen,
            data,
            received_at: Instant::now(),
        };

        if p_type == PacketType::Command {
            self.send_window_command.advance_to_excluded(p.id as u32);
        } else if p_type == PacketType::CommandLow {
            self.send_window_command_low.advance_to_excluded(p.id as u32);
        }

        let unencrypted = (flags & PacketFlags::Unencrypted) != 0;
        let header = build_c2s_header(&p);
        let (ciphertext, tag) = self
            .crypt
            .encrypt(
                p_type as u8,
                p.id,
                p.generation_id,
                &header,
                &p.data,
                dummy,
                unencrypted,
            )
            .expect("encrypt failed");

        let mut final_bytes = Vec::with_capacity(TAG_SIZE + HEADER_SIZE + ciphertext.len());
        final_bytes.extend_from_slice(&tag[..TAG_SIZE.min(tag.len())]);
        final_bytes.extend_from_slice(&header);
        final_bytes.extend_from_slice(&ciphertext);

        let rp = ResendPacket {
            packet: p,
            first_send: Instant::now(),
            last_send: Instant::now(),
            retry_count: 0,
            next_interval: RESEND_BASE_INTERVAL_MS,
        };

        if p_type == PacketType::Init1 {
            self.init_packet_check = Some(rp);
        } else if p_type == PacketType::Command || p_type == PacketType::CommandLow {
            let key = ((p_type as i64) << 16) | rp.packet.id as i64;
            self.ack_manager.insert(key, rp);
        }

        final_bytes
    }

    fn queue_send(&mut self, bytes: Vec<u8>) {
        self.pending_sends.push(bytes);
    }
}

// ---- PacketSender (lightweight handle for bg tasks) --------------------------

/// A lightweight handle that can send packets, cloned for background tasks.
pub struct PacketSender {
    core: Arc<Mutex<HandlerCore>>,
    send_tx: Arc<Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>>,
    shutdown_tx: Arc<Mutex<Option<watch::Sender<bool>>>>,
}

impl PacketSender {
    pub fn set_crypt(&self, crypt: Crypt) {
        let mut core = self.core.lock().unwrap();
        core.crypt = crypt;
    }

    pub fn send_packet(&self, p_type: PacketType, data: Vec<u8>, flags: u8) {
        let mut core = self.core.lock().unwrap();
        let dummy = !core.crypt.crypto_init_complete;

        let max_chunk = MAX_OUT_PACKET_SIZE - HEADER_SIZE - TAG_SIZE;
        if data.len() > max_chunk
            && p_type != PacketType::Voice
            && p_type != PacketType::VoiceWhisper
        {
            let mut pos = 0;
            let mut first = true;

            while pos < data.len() {
                let end = (pos + max_chunk).min(data.len());
                let last = end == data.len();

                let mut p_flags = flags;
                if first != last {
                    p_flags |= PacketFlags::Fragmented;
                }

                let chunk = data[pos..end].to_vec();
                let bytes = core.build_and_track_packet(p_type, chunk, p_flags, dummy);
                if let Some(tx) = self.send_tx.lock().unwrap().as_ref() {
                    let _ = tx.send(bytes);
                }

                pos = end;
                first = false;
            }
            return;
        }

        let bytes = core.build_and_track_packet(p_type, data, flags, dummy);
        if let Some(tx) = self.send_tx.lock().unwrap().as_ref() {
            let _ = tx.send(bytes);
        }
    }

    pub fn send_voice_packet(&self, data: Vec<u8>, codec: i32) {
        let mut core = self.core.lock().unwrap();

        let p_id = core.packet_counter[PacketType::Voice as usize];
        core.packet_counter[PacketType::Voice as usize] = p_id.wrapping_add(1);
        if core.packet_counter[PacketType::Voice as usize] == 0 {
            core.generation_counter[PacketType::Voice as usize] =
                core.generation_counter[PacketType::Voice as usize].wrapping_add(1);
        }

        let payload_len = VOICE_HEADER_SIZE + data.len();
        let mut voice_payload = vec![0u8; payload_len];
        voice_payload[..2].copy_from_slice(&p_id.to_be_bytes());
        voice_payload[2] = codec as u8;
        voice_payload[VOICE_HEADER_SIZE..].copy_from_slice(&data);

        let type_flagged = (PacketType::Voice as u8) | PacketFlags::Unencrypted;
        let header = build_c2s_header_raw(p_id, core.client_id, type_flagged);

        let mut final_bytes = Vec::with_capacity(TAG_SIZE + HEADER_SIZE + payload_len);
        final_bytes.extend_from_slice(&core.crypt.fake_signature);
        final_bytes.extend_from_slice(&header);
        final_bytes.extend_from_slice(&voice_payload);

        if let Some(tx) = self.send_tx.lock().unwrap().as_ref() {
            let _ = tx.send(final_bytes);
        }
    }

    pub fn set_client_id(&self, id: i32) {
        let mut core = self.core.lock().unwrap();
        core.client_id = id as u16;
    }

    pub fn set_crypto_init_complete(&self) {
        let mut core = self.core.lock().unwrap();
        core.crypt.crypto_init_complete = true;
    }

    pub fn received_final_init_ack(&self) {
        let mut core = self.core.lock().unwrap();
        core.init_packet_check = None;
    }

    pub fn create_command_sender(&self) -> Arc<dyn Fn(Vec<u8>) + Send + Sync> {
        let core = Arc::clone(&self.core);
        let send_tx = Arc::clone(&self.send_tx);
        Arc::new(move |data: Vec<u8>| {
            let mut core = core.lock().unwrap();
            let dummy = !core.crypt.crypto_init_complete;
            let bytes = core.build_and_track_packet(PacketType::Command, data, 0, dummy);
            drop(core);
            if let Some(tx) = send_tx.lock().unwrap().as_ref() {
                let _ = tx.send(bytes);
            }
        })
    }

    /// Close the handler — mirrors `PacketHandler::close()`.
    /// Sets closed flag, signals shutdown, and drops the send channel.
    pub fn close(&self) {
        let mut core = self.core.lock().unwrap_or_else(|e| e.into_inner());
        if core.closed {
            return;
        }
        core.closed = true;
        drop(core);

        if let Some(tx) = self.shutdown_tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(true);
        }
        self.send_tx.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
}

pub struct PacketHandler {
    on_packet: Mutex<Option<OnPacket>>,
    on_close: Mutex<Option<OnClose>>,
    core: Arc<Mutex<HandlerCore>>,
    send_tx: Arc<Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>>,
    shutdown_tx: Arc<Mutex<Option<watch::Sender<bool>>>>,
    bg_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl PacketHandler {
    pub fn set_on_packet(&self, cb: OnPacket) {
        *self.on_packet.lock().unwrap() = Some(cb);
    }

    pub fn set_on_close(&self, cb: OnClose) {
        *self.on_close.lock().unwrap() = Some(cb);
    }

    pub fn new(crypt: Crypt, logger: Arc<dyn Logger>) -> Self {
        let mut packet_counter = [0u16; 9];
        packet_counter[PacketType::Command as usize] = 1;
        packet_counter[PacketType::Init1 as usize] = 101;

        Self {
            on_packet: Mutex::new(None),
            on_close: Mutex::new(None),
            core: Arc::new(Mutex::new(HandlerCore {
                crypt,
                client_id: 0,
                closed: false,
                last_message_received: Instant::now(),
                packet_counter,
                generation_counter: [0u32; 9],
                recv_window_command: GenerationWindow::new(1 << 16, RECEIVE_PACKET_WINDOW_SIZE),
                recv_window_command_low: GenerationWindow::new(1 << 16, RECEIVE_PACKET_WINDOW_SIZE),
                send_window_command: GenerationWindow::new(1 << 16, RECEIVE_PACKET_WINDOW_SIZE),
                send_window_command_low: GenerationWindow::new(1 << 16, RECEIVE_PACKET_WINDOW_SIZE),
                command_queue: HashMap::new(),
                command_low_queue: HashMap::new(),
                ack_manager: HashMap::new(),
                init_packet_check: None,
                next_command_id: 0,
                next_command_low_id: 0,
                pending_sends: Vec::new(),
                logger: logger.clone(),
            })),
            send_tx: Arc::new(Mutex::new(None)),
            shutdown_tx: Arc::new(Mutex::new(None)),
            bg_handle: Mutex::new(None),
        }
    }

    pub fn set_client_id(&self, id: i32) {
        let mut core = self.core.lock().unwrap();
        core.client_id = id as u16;
    }

    pub fn set_crypto_init_complete(&self) {
        let mut core = self.core.lock().unwrap();
        core.crypt.crypto_init_complete = true;
    }

    pub fn received_final_init_ack(&self) {
        let mut core = self.core.lock().unwrap();
        core.init_packet_check = None;
    }

    pub fn close(&self) {
        let mut core = self.core.lock().unwrap_or_else(|e| e.into_inner());
        if core.closed {
            return;
        }
        core.closed = true;
        drop(core);

        if let Some(tx) = self.shutdown_tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(true);
        }
        self.send_tx.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    /// Take the background task handle (must call `close()` first).
    pub fn take_handle(&self) -> Option<tokio::task::JoinHandle<()>> {
        self.bg_handle.lock().unwrap().take()
    }

    pub async fn connect(&self, addr: &str) -> Result<(), crate::Error> {
        let (host, port) = parse_addr(addr);

        let socket = Arc::new(UdpSocket::bind("0.0.0.0:0").await?);
        socket.connect(format!("{}:{}", host, port)).await?;

        let (send_tx, send_rx) = mpsc::unbounded_channel();
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        let on_packet = Arc::new(Mutex::new(self.on_packet.lock().unwrap().take()));
        let on_close = Arc::new(Mutex::new(self.on_close.lock().unwrap().take()));

        let core = Arc::clone(&self.core);
        let bg_socket = Arc::clone(&socket);

        let handle = tokio::spawn(async move {
            bg_task(core, bg_socket, send_rx, shutdown_rx, on_packet, on_close).await;
        });

        *self.bg_handle.lock().unwrap() = Some(handle);
        *self.send_tx.lock().unwrap() = Some(send_tx);
        *self.shutdown_tx.lock().unwrap() = Some(shutdown_tx);

        Ok(())
    }

    pub fn send_packet(&self, p_type: PacketType, data: Vec<u8>, flags: u8) {
        let mut core = self.core.lock().unwrap();
        let dummy = !core.crypt.crypto_init_complete;

        let max_chunk = MAX_OUT_PACKET_SIZE - HEADER_SIZE - TAG_SIZE;
        if data.len() > max_chunk
            && p_type != PacketType::Voice
            && p_type != PacketType::VoiceWhisper
        {
            let mut pos = 0;
            let mut first = true;

            while pos < data.len() {
                let end = (pos + max_chunk).min(data.len());
                let last = end == data.len();

                let mut p_flags = flags;
                if first != last {
                    p_flags |= PacketFlags::Fragmented;
                }

                let chunk = data[pos..end].to_vec();
                let bytes = core.build_and_track_packet(p_type, chunk, p_flags, dummy);
                if let Some(tx) = self.send_tx.lock().unwrap().as_ref() {
                    let _ = tx.send(bytes);
                }

                pos = end;
                first = false;
            }
            return;
        }

        let bytes = core.build_and_track_packet(p_type, data, flags, dummy);
        if let Some(tx) = self.send_tx.lock().unwrap().as_ref() {
            let _ = tx.send(bytes);
        }
    }

    pub fn send_voice_packet(&self, data: Vec<u8>, codec: i32) {
        let mut core = self.core.lock().unwrap();

        let p_id = core.packet_counter[PacketType::Voice as usize];
        core.packet_counter[PacketType::Voice as usize] = p_id.wrapping_add(1);
        if core.packet_counter[PacketType::Voice as usize] == 0 {
            core.generation_counter[PacketType::Voice as usize] =
                core.generation_counter[PacketType::Voice as usize].wrapping_add(1);
        }

        let payload_len = VOICE_HEADER_SIZE + data.len();
        let mut voice_payload = vec![0u8; payload_len];
        voice_payload[..2].copy_from_slice(&p_id.to_be_bytes());
        voice_payload[2] = codec as u8;
        voice_payload[VOICE_HEADER_SIZE..].copy_from_slice(&data);

        let type_flagged = (PacketType::Voice as u8) | PacketFlags::Unencrypted;
        let header = build_c2s_header_raw(p_id, core.client_id, type_flagged);

        let mut final_bytes = Vec::with_capacity(TAG_SIZE + HEADER_SIZE + payload_len);
        final_bytes.extend_from_slice(&core.crypt.fake_signature);
        final_bytes.extend_from_slice(&header);
        final_bytes.extend_from_slice(&voice_payload);

        if let Some(tx) = self.send_tx.lock().unwrap().as_ref() {
            let _ = tx.send(final_bytes);
        }
    }

    pub fn create_command_sender(&self) -> Arc<dyn Fn(Vec<u8>) + Send + Sync> {
        let core = Arc::clone(&self.core);
        let send_tx = Arc::clone(&self.send_tx);
        Arc::new(move |data: Vec<u8>| {
            let mut core = core.lock().unwrap();
            let dummy = !core.crypt.crypto_init_complete;
            let bytes = core.build_and_track_packet(PacketType::Command, data, 0, dummy);
            drop(core);
            if let Some(tx) = send_tx.lock().unwrap().as_ref() {
                let _ = tx.send(bytes);
            }
        })
    }

    /// Create a lightweight [`PacketSender`] handle for use in background tasks.
    pub fn create_packet_sender(&self) -> PacketSender {
        PacketSender {
            core: Arc::clone(&self.core),
            send_tx: Arc::clone(&self.send_tx),
            shutdown_tx: Arc::clone(&self.shutdown_tx),
        }
    }
}

impl Drop for PacketHandler {
    fn drop(&mut self) {
        self.close();
    }
}

// ---- Background task ---------------------------------------------------------

async fn bg_task(
    core: Arc<Mutex<HandlerCore>>,
    socket: Arc<UdpSocket>,
    mut send_rx: UnboundedReceiver<Vec<u8>>,
    mut shutdown_rx: watch::Receiver<bool>,
    on_packet: Arc<Mutex<Option<OnPacket>>>,
    on_close: Arc<Mutex<Option<OnClose>>>,
) {
    let init1_result: Result<Option<Vec<u8>>, Error> = {
        let mut c = core.lock().unwrap();
        let result = process_init1(&mut c.crypt, None);
        match result {
            Ok(Some(init1_data)) => {
                let bytes = c.build_and_track_packet(PacketType::Init1, init1_data, 0, true);
                Ok(Some(bytes))
            }
            Ok(None) => Ok(None),
            Err(e) => Err(e),
        }
    };

    match init1_result {
        Ok(Some(bytes)) => {
            if socket.send(&bytes).await.is_err() {
                let mut c = core.lock().unwrap();
                trigger_close(&mut *c, &on_close, Some(Error::from("failed to send init1")));
                return;
            }
        }
        Ok(None) => {}
        Err(e) => {
            let mut c = core.lock().unwrap();
            trigger_close(&mut *c, &on_close, Some(e));
            return;
        }
    }

    let mut recv_buf = vec![0u8; 65535];
    let mut ping_interval = tokio::time::interval(Duration::from_millis(PING_INTERVAL_MS));
    let mut resend_interval = tokio::time::interval(Duration::from_millis(RESEND_LOOP_INTERVAL_MS));

    loop {
        tokio::select! {
            _ = shutdown_rx.changed() => {
                break;
            }
            result = socket.recv(&mut recv_buf) => {
                let n = match result {
                    Ok(n) => n,
                    Err(e) => {
                        let mut c = core.lock().unwrap();
                        trigger_close(&mut *c, &on_close, Some(Error::from(format!("socket recv error: {e}"))));
                        break;
                    }
                };

                let (pending, was_closed) = {
                    let mut c = core.lock().unwrap();
                    if c.closed {
                        break;
                    }
                    c.last_message_received = Instant::now();

                    handle_raw_packet(&mut c, &recv_buf[..n], &on_packet);

                    let p = c.pending_sends.drain(..).collect::<Vec<Vec<u8>>>();
                    let wc = c.closed;
                    (p, wc)
                };
                for bytes in pending {
                    let _ = socket.send(&bytes).await;
                }
                if was_closed {
                    break;
                }
            }
            Some(bytes) = send_rx.recv() => {
                let _ = socket.send(&bytes).await;
            }
            _ = ping_interval.tick() => {
                let should_ping = {
                    let c = core.lock().unwrap();
                    c.crypt.crypto_init_complete && !c.closed
                };
                if should_ping {
                    let bytes = {
                        let mut c = core.lock().unwrap();
                        c.build_and_track_packet(
                            PacketType::Ping, vec![], PacketFlags::Unencrypted, false,
                        )
                    };
                    let _ = socket.send(&bytes).await;
                }
            }
            _ = resend_interval.tick() => {
                let pending: Vec<Vec<u8>> = {
                    let mut c = core.lock().unwrap();
                    if c.closed { break; }
                    let now = Instant::now();
                    check_resends_sync(&mut c, now, &on_close);
                    c.pending_sends.drain(..).collect()
                };
                for bytes in pending {
                    let _ = socket.send(&bytes).await;
                }
            }
        }
    }

    let mut cb = on_close.lock().unwrap();
    if let Some(ref mut f) = *cb {
        f(None);
    }
}

// ---- Packet processing -------------------------------------------------------

fn handle_raw_packet(
    c: &mut HandlerCore,
    raw: &[u8],
    on_packet: &Arc<Mutex<Option<OnPacket>>>,
) {
    if raw.len() < 11 {
        return;
    }

    let tag = &raw[..TAG_SIZE];
    let header = &raw[TAG_SIZE..TAG_SIZE + 3];
    let ciphertext = &raw[TAG_SIZE + 3..];

    let (parsed_id, parsed_type_flagged) = super::packet::parse_s2c_header(header);
    let p_type_val = parsed_type_flagged & 0x0f;

    let generation_id = resolve_generation(c, parsed_id, p_type_val);

    let mut p = Packet {
        type_flagged: parsed_type_flagged,
        id: parsed_id,
        client_id: 0,
        generation_id,
        data: Vec::new(),
        received_at: Instant::now(),
    };

    let decrypted = decrypt_packet_data(c, &p, header, ciphertext, tag);
    let (plaintext, dummy_used) = match decrypted {
        Some(v) => v,
        None => return,
    };
    p.data = plaintext;

    let p_type = packet_type(&p);

    if p_type == PacketType::Ping {
        send_pong(c, p.id, dummy_used);
        return;
    }

    if !handle_command_window_and_ack(c, &p, dummy_used) {
        return;
    }

    handle_packet_queue(c, p.clone(), on_packet);
    update_post_receive_state(c, &p);
}

fn resolve_generation(c: &HandlerCore, id: u16, p_type: u8) -> u32 {
    match p_type {
        2 => c.recv_window_command.get_generation(id as u32),
        3 => c.recv_window_command_low.get_generation(id as u32),
        6 => c.send_window_command.get_generation(id as u32),
        7 => c.send_window_command_low.get_generation(id as u32),
        _ => 0,
    }
}

fn decrypt_packet_data(
    c: &mut HandlerCore,
    p: &Packet,
    header: &[u8],
    ciphertext: &[u8],
    tag: &[u8],
) -> Option<(Vec<u8>, bool)> {
    let unencrypted = is_unencrypted(p);
    let dummy = !c.crypt.crypto_init_complete;
    let dummy_used = dummy;
    let p_type_val = packet_type(p) as u8;
    let generation = p.generation_id;

    let r = c
        .crypt
        .decrypt(p_type_val, p.id, generation, header, ciphertext, tag, dummy, unencrypted);
    if let Ok(plaintext) = r {
        return Some((plaintext, dummy_used));
    }

    for &offset in &[-1i32, 1i32] {
        let guess_gen = (generation as i32).wrapping_add(offset);
        if guess_gen < 0 {
            continue;
        }
        let guess_gen = guess_gen as u32;
        let r = c
            .crypt
            .decrypt(p_type_val, p.id, guess_gen, header, ciphertext, tag, false, false);
        if let Ok(plaintext) = r {
            return Some((plaintext, false));
        }
    }

    if matches!(packet_type(p), PacketType::Command | PacketType::CommandLow | PacketType::Ack) {
        let r = c
            .crypt
            .decrypt(p_type_val, p.id, generation, header, ciphertext, tag, true, unencrypted);
        if let Ok(plaintext) = r {
            return Some((plaintext, true));
        }
    }

    None
}

fn handle_command_window_and_ack(c: &mut HandlerCore, p: &Packet, dummy_used: bool) -> bool {
    let p_type = packet_type(p);
    if p_type != PacketType::Command && p_type != PacketType::CommandLow {
        return true;
    }

    let (win, ack_type): (&mut GenerationWindow, PacketType) = if p_type == PacketType::Command {
        (&mut c.recv_window_command, PacketType::Ack)
    } else {
        (&mut c.recv_window_command_low, PacketType::AckLow)
    };

    if !win.is_in_window(p.id as u32) {
        if win.is_old_packet(p.id as u32) {
            send_ack(c, p.id, ack_type, dummy_used);
        }
        return false;
    }
    send_ack(c, p.id, ack_type, dummy_used);
    true
}

fn send_ack(c: &mut HandlerCore, packet_id: u16, ack_type: PacketType, dummy_used: bool) {
    let mut ack_data = vec![0u8; 2];
    ack_data[..2].copy_from_slice(&packet_id.to_be_bytes());
    let bytes = c.build_and_track_packet(ack_type, ack_data, 0, dummy_used);
    c.queue_send(bytes);
}

fn send_pong(c: &mut HandlerCore, p_id: u16, dummy_used: bool) {
    let mut pong_data = vec![0u8; 2];
    pong_data[..2].copy_from_slice(&p_id.to_be_bytes());
    let bytes = c.build_and_track_packet(PacketType::Pong, pong_data, PacketFlags::Unencrypted, dummy_used);
    c.queue_send(bytes);
}

fn handle_packet_queue(
    c: &mut HandlerCore,
    p: Packet,
    on_packet: &Arc<Mutex<Option<OnPacket>>>,
) {
    let p_type = packet_type(&p);
    if p_type != PacketType::Command && p_type != PacketType::CommandLow {
        let mut cb = on_packet.lock().unwrap();
        if let Some(ref mut f) = *cb {
            f(p);
        }
        return;
    }

    let is_command = p_type == PacketType::Command;
    let queue = if is_command {
        &mut c.command_queue
    } else {
        &mut c.command_low_queue
    };
    let win = if is_command {
        &mut c.recv_window_command
    } else {
        &mut c.recv_window_command_low
    };
    let next_id = if is_command {
        &mut c.next_command_id
    } else {
        &mut c.next_command_low_id
    };

    let p_id = p.id;
    queue.insert(p_id, p);

    fast_forward_missing_packets(queue, win, next_id);

    loop {
        let current = *next_id;

        let _packet = match queue.get(&current) {
            Some(p) => p,
            None => break,
        };

        let result = try_reassemble(queue, win, current);
        let (reassembled, new_next) = match result {
            Some(v) => v,
            None => break,
        };

        *next_id = new_next;

        let mut assembled = reassembled;
        try_decompress(&c.logger, &mut assembled);

        let mut cb = on_packet.lock().unwrap();
        if let Some(ref mut f) = *cb {
            f(assembled);
        }
    }
}

fn fast_forward_missing_packets(
    queue: &HashMap<u16, Packet>,
    win: &mut GenerationWindow,
    next_id: &mut u16,
) {
    while !queue.contains_key(next_id) && has_old_newer_packet(queue, *next_id) {
        *next_id = next_id.wrapping_add(1);
        win.advance(1);
    }
}

fn try_reassemble(
    queue: &mut HashMap<u16, Packet>,
    win: &mut GenerationWindow,
    next_id: u16,
) -> Option<(Packet, u16)> {
    // Standalone (non-fragmented) packet — matches JS #tryReassemble fast path.
    let is_standalone = queue
        .get(&next_id)
        .map(|p| packet_flags(p) & PacketFlags::Fragmented == 0)
        .unwrap_or(false);
    if is_standalone {
        let pkt = queue.remove(&next_id)?;
        win.advance(1);
        return Some((pkt, next_id.wrapping_add(1)));
    }

    // Fragmented sequence — collect fragment IDs until we find the terminator.
    let mut fragment_ids: Vec<u16> = Vec::new();
    let mut total_size = 0;
    let mut curr_id = next_id;
    let mut start_seen = false;

    loop {
        let frag = match queue.get(&curr_id) {
            Some(f) => f,
            None => return None,
        };
        fragment_ids.push(curr_id);
        total_size += frag.data.len();

        let fragmented = packet_flags(frag) & PacketFlags::Fragmented != 0;
        if !start_seen {
            start_seen = true;
            if !fragmented {
                break;
            }
        } else if fragmented {
            break;
        }
        curr_id = curr_id.wrapping_add(1);
    }

    let mut combined = Vec::with_capacity(total_size);

    let first_frag = queue.remove(&next_id)?;
    combined.extend_from_slice(&first_frag.data);
    win.advance(1);
    let mut new_next = next_id.wrapping_add(1);

    for &frag_id in &fragment_ids[1..] {
        if let Some(frag) = queue.remove(&frag_id) {
            combined.extend_from_slice(&frag.data);
            win.advance(1);
            new_next = frag_id.wrapping_add(1);
        }
    }

    let mut reassembled = first_frag;
    reassembled.data = combined;
    reassembled.type_flagged &= !PacketFlags::Fragmented;

    Some((reassembled, new_next))
}

fn try_decompress(logger: &Arc<dyn Logger>, packet: &mut Packet) {
    if packet_flags(packet) & PacketFlags::Compressed == 0 {
        return;
    }
    let mut qlz = Qlz::new();
    match qlz.decompress(&packet.data) {
        Ok(data) => {
            packet.data = data;
            packet.type_flagged &= !PacketFlags::Compressed;
        }
        Err(err) => {
            logger.debug(
                "decompression failed",
                &[&packet.id, &format!("{err:?}")],
            );
        }
    }
}

fn update_post_receive_state(c: &mut HandlerCore, p: &Packet) {
    let p_type = packet_type(p);

    if p_type == PacketType::Init1 {
        c.init_packet_check = None;
        return;
    }

    if (p_type == PacketType::Ack || p_type == PacketType::AckLow) && p.data.len() >= 2 {
        let ack_id = u16::from_be_bytes([p.data[0], p.data[1]]);
        let target_type = if p_type == PacketType::Ack {
            PacketType::Command
        } else {
            PacketType::CommandLow
        };
        let key = ((target_type as i64) << 16) | ack_id as i64;
        c.ack_manager.remove(&key);
    }
}

// ---- Resend logic ------------------------------------------------------------

fn check_resends_sync(
    c: &mut HandlerCore,
    now: Instant,
    on_close: &Arc<Mutex<Option<OnClose>>>,
) {
    if now.duration_since(c.last_message_received).as_millis() as u64 > PACKET_TIMEOUT_MS {
        trigger_close(c, on_close, Some(Error::from("idle timeout")));
        return;
    }

    if let Some(ref mut rp) = c.init_packet_check {
        do_resend_sync(&mut c.crypt, rp, now, &mut c.pending_sends);
    }

    // Iterate in insertion order (matching JS Map iteration).
    // Remove each entry, check timeout, do resend, then reinsert.
    let keys: Vec<i64> = c.ack_manager.keys().cloned().collect();
    for key in keys {
        let mut rp = match c.ack_manager.remove(&key) {
            Some(rp) => rp,
            None => continue,
        };

        if now.duration_since(rp.first_send).as_millis() as u64 > PACKET_TIMEOUT_MS {
            trigger_close(c, on_close, Some(Error::from("packet ack timeout")));
            return;
        }

        do_resend_sync(&mut c.crypt, &mut rp, now, &mut c.pending_sends);
        c.ack_manager.insert(key, rp);
    }
}

fn do_resend_sync(
    crypt: &mut Crypt,
    rp: &mut ResendPacket,
    now: Instant,
    pending_sends: &mut Vec<Vec<u8>>,
) {
    if (now.duration_since(rp.last_send).as_millis() as u64) < rp.next_interval {
        return;
    }

    rp.last_send = now;
    rp.retry_count += 1;
    rp.next_interval = (rp.next_interval * 2).min(MAX_RETRY_INTERVAL_MS);

    let dummy = !crypt.crypto_init_complete;
    let unencrypted = (packet_flags(&rp.packet) & PacketFlags::Unencrypted) != 0;
    let header = build_c2s_header(&rp.packet);
    let p_type = packet_type(&rp.packet);

    let (ciphertext, tag) = crypt
        .encrypt(
            p_type as u8,
            rp.packet.id,
            rp.packet.generation_id,
            &header,
            &rp.packet.data,
            dummy,
            unencrypted,
        )
        .expect("resend encrypt failed");

    let mut final_bytes = Vec::with_capacity(TAG_SIZE + HEADER_SIZE + ciphertext.len());
    final_bytes.extend_from_slice(&tag[..TAG_SIZE.min(tag.len())]);
    final_bytes.extend_from_slice(&header);
    final_bytes.extend_from_slice(&ciphertext);

    pending_sends.push(final_bytes);
}

fn trigger_close(
    c: &mut HandlerCore,
    on_close: &Arc<Mutex<Option<OnClose>>>,
    err: Option<Error>,
) {
    if c.closed {
        return;
    }
    c.closed = true;
    let mut cb = on_close.lock().unwrap();
    if let Some(ref mut f) = *cb {
        f(err);
    }
}

// ---- Helper functions --------------------------------------------------------

fn apply_protocol_flags(p_type: PacketType, flags: u8) -> u8 {
    if p_type == PacketType::Command || p_type == PacketType::CommandLow {
        flags | PacketFlags::NewProtocol
    } else {
        flags
    }
}

fn has_old_newer_packet(queue: &HashMap<u16, Packet>, next_id: u16) -> bool {
    let now = Instant::now();
    for (id, pkg) in queue {
        let id_val = *id;
        let diff = id_val.wrapping_sub(next_id) as u64;
        if diff < 0x8000 && now.duration_since(pkg.received_at).as_millis() > 5000 {
            return true;
        }
    }
    false
}

fn parse_addr(addr: &str) -> (String, u16) {
    if let Some(pos) = addr.rfind(':') {
        if pos > 0 {
            let host = addr[..pos].to_string();
            let port: u16 = addr[pos + 1..].parse().unwrap_or(9987);
            return (host, port);
        }
    }
    (addr.to_string(), 9987)
}

fn build_c2s_header_raw(id: u16, client_id: u16, type_flagged: u8) -> Vec<u8> {
    let mut header = vec![0u8; 5];
    header[..2].copy_from_slice(&id.to_be_bytes());
    header[2..4].copy_from_slice(&client_id.to_be_bytes());
    header[4] = type_flagged;
    header
}
