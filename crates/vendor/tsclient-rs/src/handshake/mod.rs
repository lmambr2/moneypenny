//! Crypto handshake orchestration & license verification

use std::collections::HashMap;

use sha1::{Digest, Sha1};

use crate::client::ClientInner;
use crate::command::{build_command, build_command_ordered};
use crate::crypto::primitives::{generate_temporary_key, sign};
use crate::transport::{PacketSender, PacketType};

pub mod crypt_handshake;
pub mod crypt_init2;
pub mod license;

pub use crypt_handshake::process_init1;
#[allow(unused_imports)]
pub use crypt_handshake::INIT_VERSION;
pub use crypt_init2::crypto_init2;
#[allow(unused_imports)]
pub use license::{parse_licenses, LicenseChain};

/// Handle the `clientinitiv` message (P-256 based crypto path).
pub fn handle_handshake_init_iv(
    inner: &mut ClientInner,
    sender: &PacketSender,
    params: &HashMap<String, String>,
) {
    let alpha = params.get("alpha").map(|s| s.as_str()).unwrap_or("");
    let beta = params.get("beta").map(|s| s.as_str()).unwrap_or("");
    let omega = params.get("omega").map(|s| s.as_str()).unwrap_or("");

    if let Err(e) = inner.crypt.init_crypto(alpha, beta, omega) {
        inner.logger.error(&format!("crypto init failed: {e}"), &[]);
        return;
    }
    inner.logger.info("crypto initialized (P-256 path), sending clientinit", &[]);
    sender.set_crypt(inner.crypt.clone());
    send_client_init(inner, sender);
}

/// Handle the `initivexpand2` message (Ed25519 / TS3 crypto path).
pub fn handle_handshake_expand2(
    inner: &mut ClientInner,
    sender: &PacketSender,
    params: &HashMap<String, String>,
) {
    inner.logger.info("received initivexpand2", &[]);
    sender.received_final_init_ack();

    let _license = params.get("l").map(|s| s.as_str()).unwrap_or("");
    let omega = params.get("omega").map(|s| s.as_str()).unwrap_or("");
    let proof = params.get("proof").map(|s| s.as_str()).unwrap_or("");
    let beta = params.get("beta").map(|s| s.as_str()).unwrap_or("");

    let private_key = send_client_ek_packet(inner, sender, beta);
    if let Err(e) = crypto_init2(&mut inner.crypt, _license, omega, proof, beta, &private_key) {
        inner.logger.error(&format!("crypto_init2 failed: {e}"), &[]);
        return;
    }
    sender.set_crypt(inner.crypt.clone());
    send_client_init(inner, sender);
}

/// Handle `initserver` — marks the client as connected.
pub fn handle_init_server(
    inner: &mut ClientInner,
    sender: &PacketSender,
    params: &HashMap<String, String>,
) {
    let id_str = params.get("aclid").or_else(|| params.get("clid")).map(|s| s.as_str()).unwrap_or("");
    let clid: i32 = id_str.parse().unwrap_or(0);

    if clid > 0 {
        inner.clid = clid;
        sender.set_client_id(clid);
    }

    inner.logger.info(&format!("connected to server, clid={}", inner.clid), &[]);
    inner.mark_connected();

    // Inform server about mute state (deferred to next tick via tokio::spawn — matches TS setImmediate)
    let update_cmd = build_command("clientupdate", HashMap::from([
        ("client_input_muted".to_string(), "0".to_string()),
        ("client_output_muted".to_string(), "0".to_string()),
    ]));
    let cmd_sender = sender.create_command_sender();
    let cmd_bytes = update_cmd.into_bytes();
    tokio::spawn(async move {
        cmd_sender(cmd_bytes);
    });
}

fn send_client_ek_packet(inner: &mut ClientInner, sender: &PacketSender, beta: &str) -> Vec<u8> {
    let (public_key, private_key) = generate_temporary_key();
    let ek_base64 = base64_encode(&public_key);
    let client_proof = build_client_ek_proof(inner, &public_key, beta);

    let client_ek = build_command_ordered("clientek", &[
        ("ek", &ek_base64),
        ("proof", &client_proof),
    ]);
    sender.send_packet(PacketType::Command, client_ek.into_bytes(), 0);
    private_key
}

fn build_client_ek_proof(inner: &ClientInner, public_key: &[u8], beta: &str) -> String {
    let beta_bytes = base64_decode(beta);
    let mut to_sign = vec![0u8; 86];
    to_sign[..32].copy_from_slice(&public_key[..public_key.len().min(32)]);
    let bb_len = beta_bytes.len().min(54);
    to_sign[32..32 + bb_len].copy_from_slice(&beta_bytes[..bb_len]);

    let sig = sign(&inner.crypt.identity.private_key, &to_sign);
    base64_encode(&sig)
}

fn prepare_client_password(password: &str) -> String {
    if password.is_empty() {
        return String::new();
    }
    let hash = Sha1::digest(password.as_bytes());
    base64_encode(&hash)
}

/// Build and send the `clientinit` command.
pub fn send_client_init(inner: &ClientInner, sender: &PacketSender) {
    let cmd = build_client_init_command(inner);
    sender.send_packet(PacketType::Command, cmd.into_bytes(), 0);
}

fn build_client_init_command(inner: &ClientInner) -> String {
    let pub_key_base64 = inner.crypt.identity.public_key_base64().to_string();
    let init_options = &inner.client_init_options;
    let default_channel_password = prepare_client_password(&init_options.default_channel_password);
    let server_password = prepare_client_password(&init_options.server_password);
    let hwid = base64_encode(&Sha1::digest(pub_key_base64.as_bytes()));

    build_command_ordered("clientinit", &[
        ("client_nickname", &inner.nickname),
        ("client_version", "3.?.? [Build: 5680278000]"),
        ("client_platform", "Windows"),
        ("client_input_hardware", "1"),
        ("client_output_hardware", "1"),
        ("client_default_channel", &init_options.default_channel),
        ("client_default_channel_password", &default_channel_password),
        ("client_server_password", &server_password),
        ("client_meta_data", ""),
        ("client_version_sign", "DX5NIYLvfJEUjuIbCidnoeozxIDRRkpq3I9vVMBmE9L2qnekOoBzSenkzsg2lC9CMv8K5hkEzhr2TYUYSwUXCg=="),
        ("client_key_offset", &inner.crypt.identity.offset.to_string()),
        ("client_nickname_phonetic", ""),
        ("client_default_token", ""),
        ("hwid", &hwid),
    ])
}

// ---- Internal helpers ---------------------------------------------------------

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn base64_decode(s: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).unwrap_or_default()
}
