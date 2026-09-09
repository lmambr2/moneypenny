use aes::Aes128;
use cipher::{BlockEncrypt, KeyInit, StreamCipher};
use ctr::Ctr128BE;

use cipher::KeyIvInit;

use crate::Error;

const BLOCK_SIZE: usize = 16;
const TAG_SIZE: usize = 8;
const RB: [u8; BLOCK_SIZE] = {
    let mut r = [0u8; BLOCK_SIZE];
    r[BLOCK_SIZE - 1] = 0x87;
    r
};

fn xor_block(a: &[u8; BLOCK_SIZE], b: &[u8; BLOCK_SIZE]) -> [u8; BLOCK_SIZE] {
    let mut out = [0u8; BLOCK_SIZE];
    for i in 0..BLOCK_SIZE {
        out[i] = a[i] ^ b[i];
    }
    out
}

fn shift_left_1(b: &[u8; BLOCK_SIZE]) -> [u8; BLOCK_SIZE] {
    let mut out = [0u8; BLOCK_SIZE];
    let mut carry = 0u8;
    for i in (0..BLOCK_SIZE).rev() {
        let shifted = (b[i] << 1) | carry;
        carry = b[i] >> 7;
        out[i] = shifted;
    }
    out
}

#[allow(non_snake_case)]
fn generate_subkeys(key: &[u8; BLOCK_SIZE]) -> ([u8; BLOCK_SIZE], [u8; BLOCK_SIZE]) {
    let cipher = Aes128::new_from_slice(key).unwrap();
    let zero = [0u8; BLOCK_SIZE];
    let mut L = zero;
    cipher.encrypt_block((&mut L).into());

    let K1 = {
        let mut k = shift_left_1(&L);
        if L[0] & 0x80 != 0 {
            k = xor_block(&k, &RB);
        }
        k
    };

    let K2 = {
        let mut k = shift_left_1(&K1);
        if K1[0] & 0x80 != 0 {
            k = xor_block(&k, &RB);
        }
        k
    };

    (K1, K2)
}

fn aes_ctr(key: &[u8; BLOCK_SIZE], iv: &[u8], data: &[u8]) -> Vec<u8> {
    let mut cipher = Ctr128BE::<Aes128>::new_from_slices(key, iv).unwrap();
    let mut result = data.to_vec();
    cipher.apply_keystream(&mut result);
    result
}

pub fn aes_cmac(key: &[u8], message: &[u8]) -> Vec<u8> {
    assert_eq!(key.len(), BLOCK_SIZE);
    let key_arr: [u8; BLOCK_SIZE] = key.try_into().unwrap();
    #[allow(non_snake_case)]
    let (K1, K2) = generate_subkeys(&key_arr);
    let cipher = Aes128::new_from_slice(key).unwrap();

    let n = std::cmp::max(1, (message.len() + BLOCK_SIZE - 1) / BLOCK_SIZE);
    let last_block_complete = !message.is_empty() && message.len() % BLOCK_SIZE == 0;

    #[allow(non_snake_case)]
    let mut X = [0u8; BLOCK_SIZE];

    for i in 0..n.saturating_sub(1) {
        let block = &message[i * BLOCK_SIZE..(i + 1) * BLOCK_SIZE];
        let block_arr: [u8; BLOCK_SIZE] = block.try_into().unwrap();
        X = xor_block(&X, &block_arr);
        cipher.encrypt_block((&mut X).into());
    }

    let mut last_block = [0u8; BLOCK_SIZE];
    let last_start = (n - 1) * BLOCK_SIZE;
    let last_slice = &message[last_start..];
    last_block[..last_slice.len()].copy_from_slice(last_slice);

    let mn = if last_block_complete {
        xor_block(&last_block, &K1)
    } else {
        if last_slice.len() < BLOCK_SIZE {
            last_block[last_slice.len()] = 0x80;
        }
        xor_block(&last_block, &K2)
    };

    X = xor_block(&X, &mn);
    cipher.encrypt_block((&mut X).into());

    X.to_vec()
}

fn cmac_with_tag(key: &[u8; BLOCK_SIZE], tag_byte: u8, data: &[u8]) -> [u8; BLOCK_SIZE] {
    let mut input = vec![0u8; BLOCK_SIZE + data.len()];
    input[BLOCK_SIZE - 1] = tag_byte;
    input[BLOCK_SIZE..].copy_from_slice(data);
    let result = aes_cmac(key, &input);
    result.try_into().unwrap()
}

/// AES-EAX AEAD (64-bit tag, AES-128).
pub struct EAX {
    key: [u8; BLOCK_SIZE],
}

impl EAX {
    pub fn new(key: &[u8]) -> Result<Self, Error> {
        if key.len() != BLOCK_SIZE {
            return Err(Error::Teamspeak("EAX requires a 16-byte key".into()));
        }
        let mut k = [0u8; BLOCK_SIZE];
        k.copy_from_slice(key);
        Ok(Self { key: k })
    }

    pub fn encrypt(
        &self,
        nonce: &[u8],
        header: &[u8],
        plaintext: &[u8],
    ) -> (Vec<u8>, Vec<u8>) {
        let n_star = cmac_with_tag(&self.key, 0, nonce);
        let h_star = cmac_with_tag(&self.key, 1, header);

        let ciphertext = aes_ctr(&self.key, &n_star, plaintext);

        let c_star = cmac_with_tag(&self.key, 2, &ciphertext);

        let tag: Vec<u8> = n_star
            .iter()
            .zip(h_star.iter())
            .zip(c_star.iter())
            .take(TAG_SIZE)
            .map(|((a, b), c)| a ^ b ^ c)
            .collect();

        (ciphertext, tag)
    }

    pub fn decrypt(
        &self,
        nonce: &[u8],
        header: &[u8],
        ciphertext: &[u8],
        tag: &[u8],
    ) -> Result<Vec<u8>, Error> {
        let n_star = cmac_with_tag(&self.key, 0, nonce);
        let h_star = cmac_with_tag(&self.key, 1, header);
        let c_star = cmac_with_tag(&self.key, 2, ciphertext);

        let expected: Vec<u8> = n_star
            .iter()
            .zip(h_star.iter())
            .zip(c_star.iter())
            .take(TAG_SIZE)
            .map(|((a, b), c)| a ^ b ^ c)
            .collect();

        if tag.len() < TAG_SIZE {
            return Err(Error::EaxTagMismatch);
        }
        let mut diff = 0u8;
        for i in 0..TAG_SIZE {
            diff |= tag[i] ^ expected[i];
        }
        if diff != 0 {
            return Err(Error::EaxTagMismatch);
        }

        Ok(aes_ctr(&self.key, &n_star, ciphertext))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_aes_cmac_basic() {
        let key = [0u8; 16];
        let msg = [0u8; 16];
        let mac = aes_cmac(&key, &msg);
        assert_eq!(mac.len(), 16);
    }

    #[test]
    fn test_eax_encrypt_decrypt() {
        let key = b"YELLOW SUBMARINE";
        let eax = EAX::new(key).unwrap();
        let nonce = b"1234567890ab";
        let header = b"header data";
        let plaintext = b"hello world";

        let (ct, tag) = eax.encrypt(nonce, header, plaintext);
        let pt = eax.decrypt(nonce, header, &ct, &tag).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn test_eax_tag_mismatch() {
        let key = b"YELLOW SUBMARINE";
        let eax = EAX::new(key).unwrap();
        let (_, tag) = eax.encrypt(b"nonce12345678", b"hdr", b"data");
        let bad_tag = vec![0u8; tag.len()];
        let result = eax.decrypt(b"nonce12345678", b"hdr", b"data", &bad_tag);
        assert!(result.is_err());
    }
}
