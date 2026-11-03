// Copyright (c) 2026 Lane Ambrose
// SPDX-License-Identifier: MIT

//! SHA-256 hex of a bearer. Sessions and handset devices share this so a
//! known vector proves both stores hash the same way. No salt.

use sha2::{Digest, Sha256};

pub(crate) fn token_sha256_hex(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_vector_includes_the_prefix() {
        assert_eq!(
            token_sha256_hex("mpd_test"),
            "36ac6fbea52ecf5adf91533d4792ea3d8a9eb018d01cba59d9de2da90fca86fe"
        );
    }
}
