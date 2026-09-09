//! Second-stage crypto initialization (Ed25519 ECDH) — mirrors `teamspeak-js/src/handshake/crypt-init2.ts`

use crate::crypto::primitives::{get_shared_secret2, verify_sign};
use crate::crypto::{import_public_key, Crypt};
use crate::Error;

use super::license::parse_licenses;

/// CryptoInit2 performs the second stage of crypto initialization (Ed25519 ECDH).
pub fn crypto_init2(
    crypt: &mut Crypt,
    license: &str,
    omega: &str,
    proof: &str,
    beta: &str,
    private_key: &[u8],
) -> Result<(), Error> {
    if crypt.alpha_tmp.is_empty() {
        return Err(Error::Teamspeak("alpha is not initialized".into()));
    }

    let license_bytes = base64_decode(license).ok_or_else(|| Error::Teamspeak("invalid license base64".into()))?;
    let omega_bytes = base64_decode(omega).ok_or_else(|| Error::Teamspeak("invalid omega base64".into()))?;
    let proof_bytes = base64_decode(proof).ok_or_else(|| Error::Teamspeak("invalid proof base64".into()))?;
    let beta_bytes = base64_decode(beta).ok_or_else(|| Error::Teamspeak("invalid beta base64".into()))?;

    let server_pub_key = import_public_key(&omega_bytes)?;

    if !verify_sign(&server_pub_key, &license_bytes, &proof_bytes) {
        return Err(Error::Teamspeak("init proof is not valid".into()));
    }

    let licenses = parse_licenses(&license_bytes)?;
    let key = licenses.derive_key();

    let shared_secret = get_shared_secret2(&key, private_key)?;

    let alpha_tmp = crypt.alpha_tmp.clone();
    crypt.set_shared_secret(&alpha_tmp, &beta_bytes, &shared_secret);
    Ok(())
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}
