//! Crypto module — ECDH, EAX, identity management

pub mod crypt;
pub mod eax;
pub mod identity;
pub mod primitives;

#[allow(unused_imports)]
pub use crypt::{Crypt, KeyNonce};
#[allow(unused_imports)]
pub use eax::{aes_cmac, EAX};
pub use identity::{
    generate_identity, get_uid_from_public_key, hash512, identity_from_string, import_public_key,
    Identity,
};
#[allow(unused_imports)]
pub use primitives::{
    clamp_scalar, generate_temporary_key, get_shared_secret2, sign, verify_sign,
};
