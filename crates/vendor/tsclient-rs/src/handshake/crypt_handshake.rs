//! Init1 handshake protocol — mirrors `teamspeak-js/src/handshake/crypt-handshake.ts`

use rand::Rng;

use crate::command::build_command_ordered;
use crate::crypto::Crypt;
use crate::Error;

pub const INIT_VERSION: u32 = 1566914096;

const INIT_VERSION_LEN: usize = 4;
const INIT_TYPE_LEN: usize = 1;
const INIT_STEP_LEN: usize = 21;

/// Handle the TS3INIT1 handshake steps.
/// Returns the response bytes to send, or None if nothing should be sent.
pub fn process_init1(crypt: &mut Crypt, data: Option<&[u8]>) -> Result<Option<Vec<u8>>, Error> {
    let data = match data {
        Some(d) if d[0] == 0x7f => return Ok(Some(build_init1_start_packet())),
        Some(d) if d.is_empty() => return Ok(None),
        Some(d) => d,
        None => return Ok(Some(build_init1_start_packet())),
    };

    match data[0] {
        0 => build_init1_step1_packet(data),
        1 => build_init1_step2_packet(data),
        2 => build_init1_step3_packet(data),
        3 => build_init1_step4_packet(crypt, data),
        _ => Ok(None),
    }
}

fn build_init1_start_packet() -> Vec<u8> {
    let mut buf = vec![0u8; INIT_VERSION_LEN + INIT_TYPE_LEN + 4 + 4 + 8];
    buf[..4].copy_from_slice(&INIT_VERSION.to_be_bytes());
    buf[4] = 0x00;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let now = if now > 0xffff_ffff { 0xffff_ffff } else { now as u32 };
    buf[5..9].copy_from_slice(&now.to_be_bytes());

    let rng: [u8; 4] = rand::rngs::OsRng.r#gen();
    buf[9..13].copy_from_slice(&rng);

    buf
}

fn build_init1_step1_packet(data: &[u8]) -> Result<Option<Vec<u8>>, Error> {
    if data.len() != INIT_STEP_LEN {
        return Ok(None);
    }

    let ts_rand_offset = INIT_VERSION_LEN + INIT_TYPE_LEN + 4;
    let ts_rand = u32::from_le_bytes(data[ts_rand_offset..ts_rand_offset + 4].try_into().unwrap());

    let mut buf = vec![0u8; INIT_TYPE_LEN + 16 + 4];
    buf[0] = 0x01;
    buf[INIT_TYPE_LEN + 16..INIT_TYPE_LEN + 16 + 4].copy_from_slice(&ts_rand.to_be_bytes());
    Ok(Some(buf))
}

fn build_init1_step2_packet(data: &[u8]) -> Result<Option<Vec<u8>>, Error> {
    if data.len() != INIT_STEP_LEN {
        return Ok(None);
    }

    let mut buf = vec![0u8; INIT_VERSION_LEN + INIT_TYPE_LEN + 16 + 4];
    buf[..4].copy_from_slice(&INIT_VERSION.to_be_bytes());
    buf[4] = 0x02;
    buf[5..].copy_from_slice(&data[1..21]);
    Ok(Some(buf))
}

fn build_init1_step3_packet(data: &[u8]) -> Result<Option<Vec<u8>>, Error> {
    let expected_len = INIT_VERSION_LEN + INIT_TYPE_LEN + 16 + 4;
    if data.len() != expected_len {
        return Ok(None);
    }

    let mut buf = vec![0u8; INIT_TYPE_LEN + 64 + 64 + 4 + 100];
    buf[0] = 0x03;
    buf[INIT_TYPE_LEN + 64 - 1] = 1;
    buf[INIT_TYPE_LEN + 64 + 64 - 1] = 1;
    buf[INIT_TYPE_LEN + 64 + 64..INIT_TYPE_LEN + 64 + 64 + 4].copy_from_slice(&1u32.to_be_bytes());
    Ok(Some(buf))
}

fn build_init1_step4_packet(crypt: &mut Crypt, data: &[u8]) -> Result<Option<Vec<u8>>, Error> {
    let expected_len = INIT_TYPE_LEN + 64 + 64 + 4 + 100;
    if data.len() != expected_len {
        return Ok(None);
    }

    let level = u32::from_be_bytes(data[1 + 128..1 + 128 + 4].try_into().unwrap()) as i32;
    let y = crypt.solve_rsa_challenge(data, 1, level)?;

    let alpha_tmp: [u8; 10] = rand::rngs::OsRng.r#gen();
    crypt.alpha_tmp = alpha_tmp.to_vec();

    let alpha_b64 = base64_encode(&alpha_tmp);
    let omega_b64 = crypt.identity.public_key_base64().to_string();

    let cmd = build_command_ordered("clientinitiv", &[
        ("alpha", &alpha_b64),
        ("omega", &omega_b64),
        ("ot", "1"),
        ("ip", ""),
    ]);
    let cmd_bytes = cmd.as_bytes();

    let mut buf = vec![0u8; INIT_VERSION_LEN + INIT_TYPE_LEN + 232 + 64 + cmd_bytes.len()];
    buf[..4].copy_from_slice(&INIT_VERSION.to_be_bytes());
    buf[4] = 0x04;
    buf[5..5 + 232].copy_from_slice(&data[1..233]);
    buf[5 + 232..5 + 232 + 64].copy_from_slice(&y[..64]);
    buf[5 + 232 + 64..].copy_from_slice(cmd_bytes);

    Ok(Some(buf))
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}
