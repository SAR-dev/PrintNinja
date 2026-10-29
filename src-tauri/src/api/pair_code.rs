//! One-time 8-character pairing codes (see docs/ARCHITECTURE.md §9 Pairing).
//!
//! The PC mints a code, shows it for 90 s by default
//! ([`PAIRING_TTL_ENV`] overrides), and holds it in memory only —
//! never in the DB or logs. The phone types it into `POST /v1/pair/claim`,
//! which mints a per-device token on success. The code is the
//! introduction; the token is the credential.

use rand::RngCore;
use std::time::{Duration, Instant};

/// 32 symbols, no `0 O 1 I` (plan §3 decision 2).
pub const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
pub const CODE_LEN: usize = 8;
/// Validity of one code, in seconds, when [`PAIRING_TTL_ENV`] is unset.
pub const DEFAULT_TTL_SECS: u64 = 90;
pub const MAX_WRONG_GUESSES: u8 = 5;

/// Environment variable that overrides how long one pairing code stays
/// valid, in whole seconds.
///
/// Unset, empty, zero or unparsable means the built-in default (90 s).
/// Like `PRINTNINJA_CUPS_URL` it is a seam, not a setting, and nothing
/// in the app sets it: longer-lived deployments (a wall display nobody
/// types from slowly) can raise it; test rigs proving expiry can lower it.
pub const PAIRING_TTL_ENV: &str = "PRINTNINJA_PAIRING_TTL_SECS";

/// How long one pairing code stays valid: [`PAIRING_TTL_ENV`] if it holds
/// a positive number of seconds, else [`DEFAULT_TTL_SECS`]. Read on every
/// check, so an override set after start-up still applies.
pub fn pairing_ttl() -> Duration {
    parse_pairing_ttl(std::env::var(PAIRING_TTL_ENV).ok().as_deref())
}

fn parse_pairing_ttl(raw: Option<&str>) -> Duration {
    match raw.map(str::trim).and_then(|v| v.parse::<u64>().ok()) {
        Some(secs) if secs > 0 => Duration::from_secs(secs),
        _ => Duration::from_secs(DEFAULT_TTL_SECS),
    }
}

/// One open pairing window. Single use, one active code at a time.
#[derive(Debug, Clone)]
pub struct PairingWindow {
    code: String,
    opened: Instant,
    wrong: u8,
    claimed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimError {
    NoWindow,
    Expired,
    Wrong { left: u8 },
    Locked,
    BadFormat,
}

impl PairingWindow {
    pub fn new(code: String, now: Instant) -> Self {
        PairingWindow {
            code,
            opened: now,
            wrong: 0,
            claimed: false,
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn wrong(&self) -> u8 {
        self.wrong
    }

    pub fn opened(&self) -> Instant {
        self.opened
    }

    pub fn is_expired(&self, now: Instant) -> bool {
        now.duration_since(self.opened) >= pairing_ttl()
    }

    pub fn is_locked(&self) -> bool {
        self.wrong >= MAX_WRONG_GUESSES
    }

    /// Check a presented code. Clock injected so tests drive time.
    pub fn claim(&mut self, presented: &str, now: Instant) -> Result<(), ClaimError> {
        if self.claimed || self.is_locked() {
            return Err(ClaimError::Locked);
        }
        if self.is_expired(now) {
            return Err(ClaimError::Expired);
        }
        let normalized = normalize_code(presented);
        if !valid_format(&normalized) {
            return Err(ClaimError::BadFormat);
        }
        if !constant_time_eq(&normalized, &self.code) {
            self.wrong += 1;
            if self.is_locked() {
                return Err(ClaimError::Locked);
            }
            return Err(ClaimError::Wrong {
                left: MAX_WRONG_GUESSES - self.wrong,
            });
        }
        self.claimed = true;
        Ok(())
    }
}

/// Uppercase, strip whitespace. Dashes are neither stripped nor
/// accepted: codes are dashless, so a dash fails `valid_format`.
pub fn normalize_code(raw: &str) -> String {
    raw.to_ascii_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect()
}

/// 8 characters, all from the alphabet.
pub fn valid_format(code: &str) -> bool {
    code.len() == CODE_LEN && code.bytes().all(|b| ALPHABET.contains(&b))
}

/// Mint an 8-character code from `OsRng`. Each byte contributes its low 5
/// bits — 256 divides 32 evenly, so masking is unbiased (no modulo bias).
pub fn generate_code() -> String {
    let mut rng = rand::rngs::OsRng;
    let mut bytes = [0u8; CODE_LEN];
    rng.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| ALPHABET[(b & 31) as usize] as char)
        .collect()
}

/// Compare without an early exit (same pattern as `secrets_match`).
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A per-device token, shown once at claim time. The PC stores only its
/// SHA-256 hex.
pub fn mint_token() -> String {
    use rand::{distributions::Alphanumeric, Rng as _};
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

/// `sha256(token)` hex. What `paired_devices.token_hash` holds.
pub fn token_hash(token: &str) -> String {
    use sha2::Digest as _;
    format!("{:x}", sha2::Sha256::digest(token.as_bytes()))
}

#[cfg(test)]
mod pair_code_tests {
    use super::*;

    #[test]
    fn generated_codes_use_only_the_alphabet() {
        for _ in 0..200 {
            let code = generate_code();
            assert_eq!(code.len(), CODE_LEN, "{code}");
            assert!(
                code.bytes().all(|b| ALPHABET.contains(&b)),
                "ambiguous char in {code}"
            );
            assert!(
                !code.bytes().any(|b| matches!(b, b'0' | b'O' | b'1' | b'I')),
                "ambiguous char in {code}"
            );
        }
    }

    #[test]
    fn normalization_strips_spaces_but_rejects_dashes() {
        assert_eq!(normalize_code("k7qm 4xpd"), "K7QM4XPD");
        assert_eq!(normalize_code("  K7QM4XPD\n"), "K7QM4XPD");
        assert!(
            !valid_format(&normalize_code("k7qm-4xpd")),
            "a dash is a format error, not cosmetics"
        );
    }

    #[test]
    fn display_form_is_the_plain_code() {
        // No dash: what the PC shows is what the phone types.
        assert_eq!(normalize_code("K7QM4XPD"), "K7QM4XPD");
    }

    #[test]
    fn accepted_before_the_default_ttl_refused_at_it() {
        // The default applies while the env override is absent; nothing
        // else in this binary sets it, so removing it here is racy with
        // nothing.
        std::env::remove_var(PAIRING_TTL_ENV);
        let start = Instant::now();
        let mut w = PairingWindow::new("K7QM4XPD".into(), start);
        assert!(w
            .claim(
                "k7qm-4xpd",
                start + Duration::from_secs(DEFAULT_TTL_SECS - 1)
            )
            .is_ok());
        let mut w = PairingWindow::new("K7QM4XPD".into(), start);
        assert_eq!(
            w.claim("K7QM4XPD", start + Duration::from_secs(DEFAULT_TTL_SECS)),
            Err(ClaimError::Expired)
        );
    }

    #[test]
    fn ttl_override_parsing() {
        let default = Duration::from_secs(DEFAULT_TTL_SECS);
        assert_eq!(parse_pairing_ttl(None), default);
        assert_eq!(parse_pairing_ttl(Some("120")), Duration::from_secs(120));
        assert_eq!(parse_pairing_ttl(Some(" 45 ")), Duration::from_secs(45));
        for raw in ["0", "", "  ", "abc", "-3", "1.5", "90s"] {
            assert_eq!(parse_pairing_ttl(Some(raw)), default, "{raw:?}");
        }
    }

    #[test]
    fn single_use_and_lockout() {
        let start = Instant::now();
        let mut w = PairingWindow::new("K7QM4XPD".into(), start);
        assert!(w.claim("K7QM4XPD", start).is_ok());
        // Second claim with the right code is refused: single use.
        assert_eq!(w.claim("K7QM4XPD", start), Err(ClaimError::Locked));
    }

    #[test]
    fn fifth_wrong_guess_locks_and_correct_afterwards_is_refused() {
        let start = Instant::now();
        let mut w = PairingWindow::new("K7QM4XPD".into(), start);
        for i in 1..MAX_WRONG_GUESSES {
            assert_eq!(
                w.claim("AAAAAAAA", start),
                Err(ClaimError::Wrong {
                    left: MAX_WRONG_GUESSES - i
                }),
                "guess {i}"
            );
        }
        // 5th wrong guess locks the window.
        assert_eq!(w.claim("AAAAAAAA", start), Err(ClaimError::Locked));
        // A correct code afterwards is refused.
        assert_eq!(w.claim("K7QM4XPD", start), Err(ClaimError::Locked));
    }

    #[test]
    fn bad_format_does_not_consume_attempts() {
        let start = Instant::now();
        let mut w = PairingWindow::new("K7QM4XPD".into(), start);
        assert_eq!(w.claim("short", start), Err(ClaimError::BadFormat));
        assert_eq!(w.wrong(), 0);
        assert_eq!(
            w.claim("AAAAAAAA", start),
            Err(ClaimError::Wrong { left: 4 })
        );
    }

    #[test]
    fn token_hash_is_stable_sha256_hex() {
        let h = token_hash("abc");
        assert_eq!(
            h,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(h.len(), 64);
    }
}
