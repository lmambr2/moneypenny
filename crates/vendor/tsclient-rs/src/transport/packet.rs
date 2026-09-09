//! Packet types and framing — mirrors `teamspeak-js/src/transport/packet.ts`

#![allow(non_upper_case_globals)]

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PacketType {
    Voice = 0,
    VoiceWhisper = 1,
    Command = 2,
    CommandLow = 3,
    Ping = 4,
    Pong = 5,
    Ack = 6,
    AckLow = 7,
    Init1 = 8,
}

pub struct PacketFlags;

impl PacketFlags {
    pub const Fragmented: u8 = 0x10;
    pub const NewProtocol: u8 = 0x20;
    pub const Compressed: u8 = 0x40;
    pub const Unencrypted: u8 = 0x80;
}

#[derive(Debug, Clone)]
pub struct Packet {
    pub type_flagged: u8,
    pub id: u16,
    pub client_id: u16,
    pub generation_id: u32,
    pub data: Vec<u8>,
    pub received_at: std::time::Instant,
}

/// 与 JS `(p.typeFlagged & 0x0f) as PacketType` 对应：直接 transmute 保留原值，
/// 不做 catch-all 映射。
pub fn packet_type(p: &Packet) -> PacketType {
    // SAFETY: PacketType 为 #[repr(u8)]，低 4 位值域 0-8 均有对应变体。
    // TS3 协议保证 type 字段不会超出已定义的变体范围。
    unsafe { std::mem::transmute(p.type_flagged & 0x0f) }
}

pub fn packet_flags(p: &Packet) -> u8 {
    p.type_flagged & 0xf0
}

pub fn is_unencrypted(p: &Packet) -> bool {
    packet_flags(p) & PacketFlags::Unencrypted != 0
}

pub fn build_c2s_header(p: &Packet) -> Vec<u8> {
    let mut header = vec![0u8; 5];
    header[..2].copy_from_slice(&p.id.to_be_bytes());
    header[2..4].copy_from_slice(&p.client_id.to_be_bytes());
    header[4] = p.type_flagged;
    header
}

pub fn parse_s2c_header(raw: &[u8]) -> (u16, u8) {
    let id = u16::from_be_bytes([raw[0], raw[1]]);
    let type_flagged = raw[2];
    (id, type_flagged)
}

#[allow(dead_code)]
pub fn parse_c2s_header(raw: &[u8]) -> (u16, u16, u8) {
    let id = u16::from_be_bytes([raw[0], raw[1]]);
    let client_id = u16::from_be_bytes([raw[2], raw[3]]);
    let type_flagged = raw[4];
    (id, client_id, type_flagged)
}
