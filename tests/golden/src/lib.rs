//! Golden-file test harness (plan §6): pins the exact byte sequences the
//! encoders and renderers must produce, byte for byte.
//!
//! Golden files live in `cases/` next to this crate. A case is a named
//! file; tests call [`assert_matches_golden`] with the actual bytes.
//!
//! Regenerating a case after an *intended* behavior change:
//!
//! ```sh
//! GOLDEN_UPDATE=1 cargo test
//! ```
//!
//! …then diff the committed golden files and confirm the change is the one
//! you meant.

use std::env;
use std::fs;
use std::path::PathBuf;

/// Directory holding the committed golden files.
pub fn cases_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("cases")
}

/// Read a committed golden file.
pub fn load_golden(name: &str) -> Vec<u8> {
    let path = cases_dir().join(name);
    fs::read(&path).unwrap_or_else(|e| panic!("golden case '{name}' missing ({path:?}): {e}"))
}

/// Assert `actual` matches the committed golden file `name` byte for
/// byte. With `GOLDEN_UPDATE=1` set, overwrites the golden file instead
/// of asserting (see crate docs).
pub fn assert_matches_golden(name: &str, actual: &[u8]) {
    let path = cases_dir().join(name);
    if env::var_os("GOLDEN_UPDATE").is_some() {
        fs::write(&path, actual).expect("write golden case");
        return;
    }
    let expected = load_golden(name);
    assert_eq!(
        actual,
        &expected[..],
        "bytes differ from golden case '{name}' ({path:?}); regenerate with \
         GOLDEN_UPDATE=1 cargo test after confirming the change is intended"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Placeholder case proving the harness round-trips real files.
    /// Replaced by real encoder output cases in phase 1 (raw console) and
    /// phase 6 (encoders).
    #[test]
    fn placeholder_case() {
        // ESC @ = ESC/POS "initialize printer", followed by a marker.
        let actual = [0x1B, 0x40, b'T', b'E', b'S', b'T'];
        assert_matches_golden("placeholder.bin", &actual);
    }
}
