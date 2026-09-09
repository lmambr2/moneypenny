//! Session encryption & decryption — mirrors `teamspeak-js/src/crypto/crypt.ts`

use std::collections::HashMap;
use sha1::Sha1;
use sha2::{Digest, Sha256};

use super::eax::EAX;
use super::identity::Identity;
use crate::Error;

const FAKE_SIGNATURE_SIZE: usize = 8;
const IV_ALPHA_SIZE: usize = 10;
const INIT1_PACKET_TYPE: u8 = 8;
const PACKET_TYPE_MASK: u8 = 0x0f;

const INIT1_MAC: &[u8] = b"TS3INIT1";

const DUMMY_KEY: &[u8] = b"c:\\windows\\syste";
const DUMMY_NONCE: &[u8] = b"m\\firewall32.cpl";

#[derive(Clone)]
pub struct KeyNonce {
    pub key: Vec<u8>,
    pub nonce: Vec<u8>,
    #[allow(dead_code)]
    pub r#gen: u32,
}

#[derive(Clone)]
pub struct Crypt {
    pub identity: Identity,
    pub iv_struct: Vec<u8>,
    pub fake_signature: Vec<u8>,
    pub alpha_tmp: Vec<u8>,
    pub crypto_init_complete: bool,
    cached_keys: HashMap<i64, KeyNonce>,
}

impl Crypt {
    pub fn new(identity: Identity) -> Self {
        Self {
            identity,
            iv_struct: Vec::new(),
            fake_signature: vec![0u8; FAKE_SIGNATURE_SIZE],
            alpha_tmp: Vec::new(),
            crypto_init_complete: false,
            cached_keys: HashMap::new(),
        }
    }

    pub fn solve_rsa_challenge(&self, data: &[u8], offset: usize, level: i32) -> Result<Vec<u8>, Error> {
        if level < 0 || level > 1_000_000 {
            return Err(Error::Teamspeak("RSA challenge level out of range".into()));
        }

        let x_bytes = &data[offset..offset + 64];
        let n_bytes = &data[offset + 64..offset + 128];

        let y = bytes_to_bigint(x_bytes);
        let n = bytes_to_bigint(n_bytes);

        let mut y = y;
        for _ in 0..level {
            y = (&y * &y) % &n;
        }

        Ok(bigint_to_bytes(&y, 64))
    }

    pub fn init_crypto(&mut self, alpha: &str, beta: &str, omega: &str) -> Result<(), Error> {
        let alpha_bytes = base64_decode(alpha).ok_or_else(|| Error::Teamspeak("invalid alpha base64".into()))?;
        let beta_bytes = base64_decode(beta).ok_or_else(|| Error::Teamspeak("invalid beta base64".into()))?;
        let omega_bytes = base64_decode(omega).ok_or_else(|| Error::Teamspeak("invalid omega base64".into()))?;

        let server_pub = super::identity::import_public_key(&omega_bytes)?;
        let shared_secret = self.get_shared_secret(&server_pub);

        self.set_shared_secret(&alpha_bytes, &beta_bytes, &shared_secret);
        Ok(())
    }

    pub fn set_shared_secret(&mut self, alpha: &[u8], beta: &[u8], shared_key: &[u8]) {
        self.iv_struct = Vec::with_capacity(IV_ALPHA_SIZE + beta.len());
        for i in 0..IV_ALPHA_SIZE {
            let a = shared_key.get(i).copied().unwrap_or(0);
            let b = alpha.get(i).copied().unwrap_or(0);
            self.iv_struct.push(a ^ b);
        }
        for i in 0..beta.len() {
            let a = shared_key.get(IV_ALPHA_SIZE + i).copied().unwrap_or(0);
            let b = beta[i];
            self.iv_struct.push(a ^ b);
        }

        let hash = Sha1::digest(&self.iv_struct);
        self.fake_signature = hash[..FAKE_SIGNATURE_SIZE].to_vec();
        self.crypto_init_complete = true;
    }

    pub fn get_key_nonce(
        &mut self,
        from_server: bool,
        packet_id: u16,
        generation_id: u32,
        packet_type: u8,
        dummy: bool,
    ) -> (Vec<u8>, Vec<u8>) {
        if dummy {
            return (DUMMY_KEY.to_vec(), DUMMY_NONCE.to_vec());
        }

        let cache_key = make_cache_key(from_server, packet_type, generation_id);

        let kn = self.cached_keys.entry(cache_key).or_insert_with(|| {
            let mut tmp = vec![0u8; 6 + self.iv_struct.len()];
            tmp[0] = if from_server { 0x30 } else { 0x31 };
            tmp[1] = packet_type & PACKET_TYPE_MASK;
            tmp[2..6].copy_from_slice(&generation_id.to_be_bytes());
            tmp[6..].copy_from_slice(&self.iv_struct);

            let hash = Sha256::digest(&tmp);
            KeyNonce {
                key: hash[..16].to_vec(),
                nonce: hash[16..32].to_vec(),
                r#gen: generation_id,
            }
        });

        let mut key = kn.key.clone();
        key[0] ^= ((packet_id >> 8) & 0xff) as u8;
        key[1] ^= (packet_id & 0xff) as u8;

        (key, kn.nonce.clone())
    }

    pub fn encrypt(
        &mut self,
        packet_type: u8,
        packet_id: u16,
        generation_id: u32,
        header: &[u8],
        plaintext: &[u8],
        dummy: bool,
        unencrypted: bool,
    ) -> Result<(Vec<u8>, Vec<u8>), Error> {
        if packet_type == INIT1_PACKET_TYPE {
            return Ok((plaintext.to_vec(), INIT1_MAC.to_vec()));
        }
        if unencrypted {
            return Ok((plaintext.to_vec(), self.fake_signature.clone()));
        }

        let (key, nonce) = self.get_key_nonce(false, packet_id, generation_id, packet_type, dummy);
        let eax = EAX::new(&key)?;
        Ok(eax.encrypt(&nonce, header, plaintext))
    }

    pub fn decrypt(
        &mut self,
        packet_type: u8,
        packet_id: u16,
        generation_id: u32,
        header: &[u8],
        ciphertext: &[u8],
        tag: &[u8],
        dummy: bool,
        unencrypted: bool,
    ) -> Result<Vec<u8>, Error> {
        if packet_type == INIT1_PACKET_TYPE {
            return Ok(ciphertext.to_vec());
        }
        if unencrypted {
            let fs_sub = tag.get(..FAKE_SIGNATURE_SIZE).unwrap_or_default();
            if fs_sub != self.fake_signature.as_slice() {
                return Err(Error::FakeSignatureMismatch);
            }
            return Ok(ciphertext.to_vec());
        }

        let (key, nonce) = self.get_key_nonce(true, packet_id, generation_id, packet_type, dummy);
        let eax = EAX::new(&key)?;
        eax.decrypt(&nonce, header, ciphertext, tag)
    }

    fn get_shared_secret(&self, server_pub: &[u8; 65]) -> Vec<u8> {
        use p256::{SecretKey, PublicKey};

        let secret = SecretKey::from_slice(&self.identity.private_key).unwrap();
        let pub_key = PublicKey::from_sec1_bytes(server_pub).unwrap();
        let shared_point = p256::ecdh::diffie_hellman(secret.to_nonzero_scalar(), pub_key.as_affine());
        let raw_secret = shared_point.raw_secret_bytes();
        Sha1::digest(raw_secret).to_vec()
    }
}

// ---- Helpers ----------------------------------------------------------------

fn make_cache_key(from_server: bool, packet_type: u8, generation_id: u32) -> i64 {
    let mut key = 0i64;
    if from_server {
        key |= 1i64 << 40;
    }
    key |= ((packet_type & PACKET_TYPE_MASK) as i64) << 32;
    key |= generation_id as i64;
    key
}

fn bytes_to_bigint(bytes: &[u8]) -> num_bigint::BigInt {
    let mut result = num_bigint::BigInt::ZERO;
    for &b in bytes {
        result = (&result << 8) + num_bigint::BigInt::from(b);
    }
    result
}

fn bigint_to_bytes(value: &num_bigint::BigInt, size: usize) -> Vec<u8> {
    let mut result = vec![0u8; size];
    let mut v = value.clone();
    for i in (0..size).rev() {
        let (_, byte_vec) = (&v & num_bigint::BigInt::from(0xffu8)).to_bytes_le();
        result[i] = byte_vec.first().copied().unwrap_or(0);
        v >>= 8;
    }
    result
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}
