//! Ed25519 cryptographic primitives — mirrors `teamspeak-js/src/crypto/primitives.ts`

use sha2::{Digest, Sha512};

use crate::Error;

const CURVE25519_KEY_SIZE: usize = 32;
const CLAMP_MASK_LOW: u8 = 248;
const CLAMP_MASK_HIGH: u8 = 127;
const CLAMP_HIGH_BIT: u8 = 64;
const SHARED_SIGN_BIT: u8 = 0x80;
const PRIVATE_KEY_TOP_MASK: u8 = 0x7f;

/// Clamp a Curve25519 scalar in-place.
pub fn clamp_scalar(key: &mut [u8]) {
    if key.len() < CURVE25519_KEY_SIZE {
        return;
    }
    key[0] &= CLAMP_MASK_LOW;
    key[CURVE25519_KEY_SIZE - 1] =
        (key[CURVE25519_KEY_SIZE - 1] & CLAMP_MASK_HIGH) | CLAMP_HIGH_BIT;
}

/// Generate an ephemeral Ed25519 key pair.
/// Returns `(public_key, private_key)` — both 32 bytes.
pub fn generate_temporary_key() -> (Vec<u8>, Vec<u8>) {
    let mut bytes = [0u8; 32];
    rand::Rng::fill(&mut rand::rngs::OsRng, &mut bytes);
    clamp_scalar(&mut bytes);

    let scalar = curve25519_dalek::scalar::Scalar::from_bytes_mod_order(bytes);
    let point = curve25519_dalek::constants::ED25519_BASEPOINT_POINT * scalar;
    let pub_bytes = point.compress().to_bytes();

    (pub_bytes.to_vec(), bytes.to_vec())
}

/// Sign data with a P-256 private key (SHA-256 hash, ASN.1 DER signature).
pub fn sign(private_key: &[u8], data: &[u8]) -> Vec<u8> {
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::{Signature, SigningKey};
    let signing_key = SigningKey::from_slice(private_key).expect("invalid P-256 private key");
    let sig: Signature = signing_key.sign(data);
    sig.to_der().to_bytes().to_vec()
}

/// Verify a P-256 ECDSA signature (SHA-256 hash, ASN.1 DER encoded).
pub fn verify_sign(public_key: &[u8], data: &[u8], sig: &[u8]) -> bool {
    use p256::ecdsa::{Signature, VerifyingKey};
    use p256::ecdsa::signature::Verifier;
    let Ok(verifying_key) = VerifyingKey::from_sec1_bytes(public_key) else {
        return false;
    };
    let Ok(sig) = Signature::from_der(sig) else {
        return false;
    };
    verifying_key.verify(data, &sig).is_ok()
}

/// TS3-specific shared secret derivation using Ed25519 point arithmetic.
pub fn get_shared_secret2(public_key_bytes: &[u8], private_key_bytes: &[u8]) -> Result<Vec<u8>, Error> {
    if public_key_bytes.len() != CURVE25519_KEY_SIZE
        || private_key_bytes.len() != CURVE25519_KEY_SIZE
    {
        return Err(Error::Teamspeak("invalid key length".into()));
    }

    let mut priv_copy = [0u8; 32];
    priv_copy.copy_from_slice(private_key_bytes);
    priv_copy[CURVE25519_KEY_SIZE - 1] &= PRIVATE_KEY_TOP_MASK;

    let raw_scalar = num_bigint::BigUint::from_bytes_le(&priv_copy);
    #[allow(deprecated)]
    let n = curve25519_dalek::constants::BASEPOINT_ORDER;
    let n_biguint = num_bigint::BigUint::from_bytes_le(&n.to_bytes());

    let pub_point = {
        let bytes: [u8; 32] = public_key_bytes.try_into().unwrap();
        curve25519_dalek::edwards::CompressedEdwardsY(bytes)
            .decompress()
            .ok_or_else(|| Error::Teamspeak("invalid edwards point".into()))?
    };
    let neg_pub = -pub_point;

    let shared_point = scalar_mult_full(&neg_pub, &raw_scalar, &n_biguint);
    let mut shared_bytes = shared_point.compress().to_bytes();

    // Flip sign bit
    shared_bytes[CURVE25519_KEY_SIZE - 1] ^= SHARED_SIGN_BIT;

    let hash = Sha512::digest(&shared_bytes);
    Ok(hash.to_vec())
}

/// Multiply an Ed25519 point by a scalar that may be >= curve order n.
pub(crate) fn scalar_mult_full(
    point: &curve25519_dalek::edwards::EdwardsPoint,
    scalar: &num_bigint::BigUint,
    n: &num_bigint::BigUint,
) -> curve25519_dalek::edwards::EdwardsPoint {
    use curve25519_dalek::edwards::EdwardsPoint;
    use curve25519_dalek::scalar::Scalar;
    use curve25519_dalek::traits::Identity;

    if scalar < n {
        let s = Scalar::from_bytes_mod_order(to_le_bytes(scalar));
        if scalar == &num_bigint::BigUint::ZERO {
            return EdwardsPoint::identity();
        }
        return point * s;
    }

    let remainder = scalar % n;
    let quotient = scalar / n;

    // P * r
    let main_part = if remainder == num_bigint::BigUint::ZERO {
        EdwardsPoint::identity()
    } else {
        let s = Scalar::from_bytes_mod_order(to_le_bytes(&remainder));
        point * s
    };

    // P * n = P * (n - 1) + P
    let n_minus_1 = n - 1u64;
    let s_n1 = Scalar::from_bytes_mod_order(to_le_bytes(&n_minus_1));
    let point_times_n = point * s_n1 + point;

    // (P * n) * q
    let q_scalar = Scalar::from_bytes_mod_order(to_le_bytes(&quotient));
    let cofactor_part = point_times_n * q_scalar;

    main_part + cofactor_part
}

pub(crate) fn to_le_bytes(bigint: &num_bigint::BigUint) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    let le = bigint.to_bytes_le();
    let len = le.len().min(32);
    bytes[..len].copy_from_slice(&le[..len]);
    bytes
}
