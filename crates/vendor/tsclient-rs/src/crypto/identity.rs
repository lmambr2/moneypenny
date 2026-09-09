//! P-256 identity management — mirrors `teamspeak-js/src/crypto/identity.ts`

use sha1::Sha1;
use sha2::{Digest, Sha512};

use crate::types::AbortSignal;
use crate::Error;

const P256_SCALAR_SIZE: usize = 32;
const P256_UNCOMPRESSED_KEY_SIZE: usize = 65;

/// A TS3 client identity backed by a P-256 key pair.
pub struct Identity {
    pub private_key: [u8; P256_SCALAR_SIZE],
    pub offset: i64,
    cached: std::sync::OnceLock<IdentityCache>,
}

impl Clone for Identity {
    fn clone(&self) -> Self {
        Self {
            private_key: self.private_key,
            offset: self.offset,
            cached: std::sync::OnceLock::new(),
        }
    }
}

struct IdentityCache {
    public_key_base64: String,
    public_key_bytes: [u8; P256_UNCOMPRESSED_KEY_SIZE],
}

impl Identity {
    fn new(private_key: [u8; P256_SCALAR_SIZE], offset: i64) -> Self {
        Self {
            private_key,
            offset,
            cached: std::sync::OnceLock::new(),
        }
    }

    fn compute_cache(&self) -> &IdentityCache {
        self.cached.get_or_init(|| {
            let pub_bytes = derive_p256_public_key(&self.private_key);
            let x = &pub_bytes[1..33];
            let y = &pub_bytes[33..65];
            let b64 = ts_public_key_to_base64(x, y);
            IdentityCache {
                public_key_base64: b64,
                public_key_bytes: pub_bytes,
            }
        })
    }

    pub fn public_key_base64(&self) -> &str {
        &self.compute_cache().public_key_base64
    }

    pub fn public_key_bytes(&self) -> &[u8; P256_UNCOMPRESSED_KEY_SIZE] {
        &self.compute_cache().public_key_bytes
    }

    pub fn to_string(&self) -> String {
        format!("{}:{}", base64_encode(&self.private_key), self.offset)
    }

    pub fn security_level(&self) -> i32 {
        let hash = sha1_hash(format!(
            "{}{}",
            self.public_key_base64(),
            self.offset
        ));
        count_leading_zeros(&hash)
    }

    pub async fn upgrade_to_level(&mut self, target_level: i32, signal: Option<&AbortSignal>) -> Result<(), Error> {
        let prefix = self.public_key_base64().to_string();
        loop {
            if let Some(sig) = signal {
                if sig.is_aborted() {
                    return Err(Error::Teamspeak("aborted".into()));
                }
            }
            let hash = sha1_hash(format!("{prefix}{}", self.offset));
            if count_leading_zeros(&hash) >= target_level {
                return Ok(());
            }
            self.offset += 1;
            if self.offset % 10000 == 0 {
                tokio::task::yield_now().await;
            }
        }
    }
}

pub fn identity_from_string(s: &str) -> Result<Identity, Error> {
    let colon_idx = s.rfind(':').ok_or_else(Error::invalid_identity)?;
    let d_base64 = &s[..colon_idx];
    let offset_str = &s[colon_idx + 1..];

    let d_bytes = base64_decode(d_base64).ok_or_else(Error::invalid_identity)?;
    let offset: i64 = offset_str.parse().map_err(|_| Error::invalid_identity())?;

    if d_bytes.len() > P256_SCALAR_SIZE {
        return Err(Error::invalid_identity());
    }

    let mut padded = [0u8; P256_SCALAR_SIZE];
    padded[P256_SCALAR_SIZE - d_bytes.len()..].copy_from_slice(&d_bytes);
    Ok(Identity::new(padded, offset))
}

pub fn generate_identity(target_level: i32) -> Identity {
    loop {
        let private_key = generate_p256_private_key();
        let id = Identity::new(private_key, 0);
        let prefix = id.public_key_base64().to_string();

        let mut offset = 0i64;
        loop {
            let hash = sha1_hash(format!("{prefix}{offset}"));
            if count_leading_zeros(&hash) >= target_level {
                let mut result = Identity::new(private_key, offset);
                result.cached = std::sync::OnceLock::from(IdentityCache {
                    public_key_base64: prefix.clone(),
                    public_key_bytes: *id.public_key_bytes(),
                });
                return result;
            }
            offset += 1;
        }
    }
}

pub fn get_uid_from_public_key(public_key: &str) -> String {
    let hash = sha1_hash(public_key.to_string());
    base64_encode(&hash)
}

pub fn hash512(data: &[u8]) -> Vec<u8> {
    Sha512::digest(data).to_vec()
}

pub fn import_public_key(data: &[u8]) -> Result<[u8; P256_UNCOMPRESSED_KEY_SIZE], Error> {
    // Try canonical: SEQUENCE { BIT_STRING, INTEGER(32), INTEGER(x), INTEGER(y) }
    if let Some(point) = try_parse_ts_canonical(data) {
        return Ok(point);
    }
    // Try legacy: SEQUENCE { INTEGER(x), INTEGER(y), ... }
    if let Some(point) = try_parse_ts_legacy(data) {
        return Ok(point);
    }
    Err(Error::Teamspeak("invalid public key DER".into()))
}

// ---- P-256 helpers -----------------------------------------------------------

fn generate_p256_private_key() -> [u8; P256_SCALAR_SIZE] {
    use rand::Rng;
    let mut bytes = [0u8; P256_SCALAR_SIZE];
    rand::rngs::OsRng.fill(&mut bytes);
    bytes
}

fn derive_p256_public_key(private_key: &[u8; P256_SCALAR_SIZE]) -> [u8; P256_UNCOMPRESSED_KEY_SIZE] {
    let secret = p256::SecretKey::from_slice(private_key).unwrap();
    let public_key = secret.public_key();
    let encoded = p256::EncodedPoint::from(public_key);
    let bytes = encoded.as_bytes();
    let mut point = [0u8; P256_UNCOMPRESSED_KEY_SIZE];
    point.copy_from_slice(bytes);
    point
}

// ---- TS3 canonical ASN.1 encoding --------------------------------------------

fn ts_public_key_to_base64(x: &[u8], y: &[u8]) -> String {
    // SEQUENCE { BIT_STRING(0x07,0x00), INTEGER(32), INTEGER(x), INTEGER(y) }
    let mut der = vec![0x30];
    let bit_string = vec![0x03, 0x02, 0x07, 0x00];
    let size_int = encode_integer(&[32]);
    let x_int = encode_integer(x);
    let y_int = encode_integer(y);

    let mut body = Vec::new();
    body.extend_from_slice(&bit_string);
    body.extend_from_slice(&size_int);
    body.extend_from_slice(&x_int);
    body.extend_from_slice(&y_int);
    der.extend_from_slice(&encode_length(body.len()));
    der.extend_from_slice(&body);
    base64_encode(&der)
}

fn encode_length(len: usize) -> Vec<u8> {
    if len < 128 {
        vec![len as u8]
    } else if len < 256 {
        vec![0x81, len as u8]
    } else {
        vec![0x82, (len >> 8) as u8, (len & 0xff) as u8]
    }
}

fn encode_integer(value: &[u8]) -> Vec<u8> {
    let mut start = 0;
    while start < value.len().saturating_sub(1) && value[start] == 0 {
        start += 1;
    }
    let trimmed = &value[start..];
    if trimmed.is_empty() {
        return vec![0x02, 0x01, 0x00];
    }
    let has_high_bit = trimmed[0] & 0x80 != 0;
    let content_len = trimmed.len() + if has_high_bit { 1 } else { 0 };
    let mut der = vec![0x02];
    der.extend_from_slice(&encode_length(content_len));
    if has_high_bit {
        der.push(0x00);
    }
    der.extend_from_slice(trimmed);
    der
}

fn try_parse_ts_canonical(data: &[u8]) -> Option<[u8; P256_UNCOMPRESSED_KEY_SIZE]> {
    // Minimal DER parser for the canonical format
    if data.len() < 10 || data[0] != 0x30 {
        return None;
    }
    let (seq_body, _) = parse_der_sequence(data)?;
    let mut offset = 0;

    let (_bs, consumed) = parse_der_tlv(&seq_body, 0x03, offset)?;
    offset += consumed;

    let (_size_int, consumed) = parse_der_tlv(&seq_body, 0x02, offset)?;
    offset += consumed;

    let (x_val, consumed) = parse_der_tlv(&seq_body, 0x02, offset)?;
    offset += consumed;

    let (y_val, _consumed) = parse_der_tlv(&seq_body, 0x02, offset)?;

    let x = normalize_integer(&x_val, P256_SCALAR_SIZE)?;
    let y = normalize_integer(&y_val, P256_SCALAR_SIZE)?;
    build_uncompressed_point(&x, &y)
}

fn try_parse_ts_legacy(data: &[u8]) -> Option<[u8; P256_UNCOMPRESSED_KEY_SIZE]> {
    if data.len() < 8 || data[0] != 0x30 {
        return None;
    }
    let (seq_body, _) = parse_der_sequence(data)?;
    let mut offset = 0;

    let (x_val, consumed) = parse_der_tlv(&seq_body, 0x02, offset)?;
    offset += consumed;

    let (y_val, _consumed) = parse_der_tlv(&seq_body, 0x02, offset)?;

    let x = normalize_integer(&x_val, P256_SCALAR_SIZE)?;
    let y = normalize_integer(&y_val, P256_SCALAR_SIZE)?;
    build_uncompressed_point(&x, &y)
}

fn parse_der_sequence(data: &[u8]) -> Option<(&[u8], usize)> {
    if data.is_empty() || data[0] != 0x30 {
        return None;
    }
    let (body, consumed) = parse_der_body(&data[1..])?;
    Some((body, consumed + 1))
}

fn parse_der_tlv(data: &[u8], expected_tag: u8, offset: usize) -> Option<(Vec<u8>, usize)> {
    let remaining = data.get(offset..)?;
    if remaining.is_empty() || remaining[0] != expected_tag {
        return None;
    }
    let (body, body_consumed) = parse_der_body(&remaining[1..])?;
    Some((body.to_vec(), body_consumed + 1))
}

fn parse_der_body(data: &[u8]) -> Option<(&[u8], usize)> {
    if data.is_empty() {
        return None;
    }
    let first = data[0];
    let (len, len_size): (usize, usize) = if first < 0x80 {
        (first as usize, 1)
    } else if first == 0x81 {
        (data.get(1)?.clone() as usize, 2)
    } else if first == 0x82 {
        let hi = *data.get(1)? as usize;
        let lo = *data.get(2)? as usize;
        ((hi << 8) | lo, 3)
    } else {
        return None;
    };
    let body_start = len_size;
    let body_end = body_start + len;
    if body_end > data.len() {
        return None;
    }
    Some((&data[body_start..body_end], body_start + len))
}

fn normalize_integer(int_val: &[u8], size: usize) -> Option<Vec<u8>> {
    let mut start = 0;
    while start < int_val.len().saturating_sub(1) && int_val[start] == 0x00 {
        start += 1;
    }
    let stripped = &int_val[start..];
    if stripped.len() > size {
        return None;
    }
    let mut padded = vec![0u8; size];
    padded[size - stripped.len()..].copy_from_slice(stripped);
    Some(padded)
}

fn build_uncompressed_point(x: &[u8], y: &[u8]) -> Option<[u8; P256_UNCOMPRESSED_KEY_SIZE]> {
    if x.len() != P256_SCALAR_SIZE || y.len() != P256_SCALAR_SIZE {
        return None;
    }
    let mut point = [0u8; P256_UNCOMPRESSED_KEY_SIZE];
    point[0] = 0x04;
    point[1..33].copy_from_slice(x);
    point[33..65].copy_from_slice(y);
    Some(point)
}

// ---- Misc helpers -----------------------------------------------------------

fn count_leading_zeros(data: &[u8]) -> i32 {
    let mut zeros = 0;
    for &b in data {
        if b == 0 {
            zeros += 8;
        } else {
            for i in 0..8usize {
                if (b & (1 << i)) == 0 {
                    zeros += 1;
                } else {
                    return zeros;
                }
            }
        }
    }
    zeros
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

fn sha1_hash(s: String) -> Vec<u8> {
    let mut hasher = Sha1::new();
    hasher.update(s.as_bytes());
    hasher.finalize().to_vec()
}
