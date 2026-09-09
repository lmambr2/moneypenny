//! License chain parsing & key derivation — mirrors `teamspeak-js/src/handshake/license.ts`

use crate::crypto::hash512;
use crate::Error;

const LICENSE_ROOT_KEY: [u8; 32] = [
    0xcd, 0x0d, 0xe2, 0xae, 0xd4, 0x63, 0x45, 0x50, 0x9a, 0x7e, 0x3c, 0xfd, 0x8f, 0x68, 0xb3, 0xdc,
    0x75, 0x55, 0xb2, 0x9d, 0xcc, 0xec, 0x73, 0xcd, 0x18, 0x75, 0x0f, 0x99, 0x38, 0x12, 0x40, 0x8a,
];

#[derive(Debug, Clone)]
struct LicenseBlock {
    key: Vec<u8>,
    hash: Vec<u8>,
    _properties: Vec<Vec<u8>>,
    _issuer: String,
    _block_type: u8,
    _server_type: u8,
    #[allow(dead_code)]
    not_valid_before: u32,
    #[allow(dead_code)]
    not_valid_after: u32,
}

pub struct LicenseChain {
    blocks: Vec<LicenseBlock>,
}

impl LicenseChain {
    fn new(blocks: Vec<LicenseBlock>) -> Self {
        Self { blocks }
    }

    /// Derive the session key by chaining Ed25519 point arithmetic.
    pub fn derive_key(&self) -> Vec<u8> {
        let mut round = LICENSE_ROOT_KEY.to_vec();
        for block in &self.blocks {
            round = derive_key_from_block(block, &round);
        }
        round
    }
}

pub fn parse_licenses(data: &[u8]) -> Result<LicenseChain, Error> {
    if data.is_empty() {
        return Err(Error::Teamspeak("license too short".into()));
    }
    if data[0] != 1 {
        return Err(Error::Teamspeak("unsupported license version".into()));
    }

    let mut remaining = &data[1..];
    let mut blocks = Vec::new();

    while !remaining.is_empty() {
        let (block, consumed) = parse_license_block(remaining)?;
        blocks.push(block);
        remaining = &remaining[consumed..];
    }

    Ok(LicenseChain::new(blocks))
}

fn parse_license_block(data: &[u8]) -> Result<(LicenseBlock, usize), Error> {
    const MIN_BLOCK_LEN: usize = 42;
    if data.len() < MIN_BLOCK_LEN {
        return Err(Error::Teamspeak("license too short".into()));
    }
    if data[0] != 0 {
        return Err(Error::Teamspeak(format!("wrong key kind in license: {}", data[0])));
    }

    let block_type = data[33];
    let unix_offset: u32 = 0x50e22700;
    let before_raw = u32::from_be_bytes(data[34..38].try_into().unwrap());
    let after_raw = u32::from_be_bytes(data[38..42].try_into().unwrap());

    if after_raw < before_raw {
        return Err(Error::Teamspeak("license times are invalid".into()));
    }

    let key = data[1..33].to_vec();

    let (payload, payload_read) = parse_block_payload(block_type, data, MIN_BLOCK_LEN)?;

    let all_len = MIN_BLOCK_LEN + payload_read;
    let hash_input = &data[1..all_len];
    let hash_full = hash512(hash_input);
    let hash = hash_full[..32].to_vec();

    Ok((
        LicenseBlock {
            key,
            hash,
            _properties: payload.0,
            _issuer: payload.1,
            _block_type: block_type,
            _server_type: payload.2,
            not_valid_before: before_raw + unix_offset,
            not_valid_after: after_raw + unix_offset,
        },
        all_len,
    ))
}

struct BlockPayload(Vec<Vec<u8>>, String, u8);

fn parse_block_payload(
    block_type: u8,
    data: &[u8],
    min_block_len: usize,
) -> Result<(BlockPayload, usize), Error> {
    match block_type {
        0 => {
            // Intermediate
            let (issuer, read) = read_null_string(&data[46..])?;
            Ok((BlockPayload(vec![], issuer, 0), 5 + read))
        }
        2 => {
            // Server
            let server_type = data[42];
            let (issuer, read) = read_null_string(&data[47..])?;
            Ok((BlockPayload(vec![], issuer, server_type), 6 + read))
        }
        8 => {
            // TS5Server
            let server_type = data[42];
            let prop_count = data.get(43).copied().unwrap_or(0);
            let mut pos = 44;
            let mut properties = Vec::new();
            for _ in 0..prop_count {
                if pos >= data.len() {
                    return Err(Error::Teamspeak("license too short".into()));
                }
                let prop_len = data[pos] as usize;
                pos += 1;
                if pos + prop_len > data.len() {
                    return Err(Error::Teamspeak("license too short".into()));
                }
                properties.push(data[pos..pos + prop_len].to_vec());
                pos += prop_len;
            }
            Ok((BlockPayload(properties, String::new(), server_type), pos - min_block_len))
        }
        32 => {
            // Ephemeral
            Ok((BlockPayload(vec![], String::new(), 0), 0))
        }
        _ => Err(Error::Teamspeak(format!("invalid license block type: {block_type}"))),
    }
}

fn read_null_string(data: &[u8]) -> Result<(String, usize), Error> {
    for i in 0..data.len() {
        if data[i] == 0 {
            let s = String::from_utf8_lossy(&data[..i]).to_string();
            return Ok((s, i));
        }
    }
    Err(Error::Teamspeak("non-null-terminated issuer string".into()))
}

fn derive_key_from_block(block: &LicenseBlock, parent: &[u8]) -> Vec<u8> {
    use curve25519_dalek::edwards::CompressedEdwardsY;

    let hash = &block.hash;
    let block_key = &block.key;
    let mut scalar_bytes = [0u8; 32];
    scalar_bytes.copy_from_slice(&hash[..32]);
    crate::crypto::primitives::clamp_scalar(&mut scalar_bytes);
    let raw_scalar = num_bigint::BigUint::from_bytes_le(&scalar_bytes);

    #[allow(deprecated)]
    let n = curve25519_dalek::constants::BASEPOINT_ORDER;
    let n_biguint = num_bigint::BigUint::from_bytes_le(&n.to_bytes());

    let pub_bytes: [u8; 32] = block_key.as_slice().try_into().expect("block_key len != 32");
    let pub_point = CompressedEdwardsY(pub_bytes)
        .decompress()
        .expect("invalid edwards point in block_key");
    let neg_pub = -pub_point;

    let res1 = crate::crypto::primitives::scalar_mult_full(&neg_pub, &raw_scalar, &n_biguint);

    let par_bytes: [u8; 32] = parent.try_into().expect("parent len != 32");
    let par_point = CompressedEdwardsY(par_bytes)
        .decompress()
        .expect("invalid edwards point in parent");
    let neg_par = -par_point;

    let result = res1 + neg_par;
    let mut raw = result.compress().to_bytes();
    raw[31] ^= 0x80;
    raw.to_vec()
}
