//! Pairing helpers: what both devices use to recognise each other.
//!
//! QR link pairing is gone — pairing is now an 8-character code (docs/PEER_RENDERING.md §Trust and pairing): the
//! PC shows an 8-character code (`api::pair_code`), the phone types it,
//! and the claim mints a per-device token. What remains here is the
//! SHA-256 fingerprint helper — the hash stored in
//! `paired_devices.token_hash` and shown for token comparison.

use sha2::Digest as _;

/// SHA-256 of a token, hex. The PC stores this, never the token itself.
pub fn fingerprint(secret: &str) -> String {
    format!("{:x}", sha2::Sha256::digest(secret.as_bytes()))
}

#[cfg(test)]
mod pairing_tests {
    use super::*;

    #[test]
    fn fingerprint_is_a_stable_sha256_hex() {
        let fp = fingerprint("abc");
        assert_eq!(
            fp,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(fp.len(), 64);
    }
}
