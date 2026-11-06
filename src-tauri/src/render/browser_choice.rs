//! The user's browser preference (Settings → Diagnostics → "Print browser"):
//! which browser the renderer uses — automatic, the system browser, the
//! downloaded headless shell, or a custom path.
//!
//! Stored in the settings table under [`CHOICE_KEY`] / [`CUSTOM_PATH_KEY`].
//! Neither key is an account key (see `commands::settings::
//! ACCOUNT_SETTING_KEYS`), so both are device-local and never sync.
//!
//! The render layer never touches the database — it also runs in binaries
//! that must stay free of it (the 0xc0000139 lesson). Instead it reads this
//! small cached copy, which [`apply_from`] refreshes from the settings
//! table: once at app setup, after every `set_setting` of these keys, and
//! after a device reset. The `PRINTNINJA_EDGE_BIN` /
//! `PRINTNINJA_CHROMIUM_BIN` environment variables always override the
//! choice (operator lever).

pub const CHOICE_KEY: &str = "browser-choice";
pub const CUSTOM_PATH_KEY: &str = "browser-custom-path";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BrowserChoice {
    /// The downloaded headless shell when it is on disk, otherwise the
    /// system browser. The default: today's behaviour.
    #[default]
    Auto,
    /// The system browser (Edge on Windows, a Chromium-family browser on
    /// Linux), even when the downloaded shell is installed.
    System,
    /// The downloaded headless shell, and only it: a missing download is a
    /// loud error, not a silent fall-back.
    Shell,
    /// A user-supplied executable path ([`CUSTOM_PATH_KEY`]).
    Custom,
}

impl BrowserChoice {
    /// Unknown values (including legacy/typo rows) degrade to `Auto`, the
    /// safe default that always tries every browser.
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "system" | "edge" => Self::System,
            "shell" => Self::Shell,
            "custom" => Self::Custom,
            _ => Self::Auto,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::System => "system",
            Self::Shell => "shell",
            Self::Custom => "custom",
        }
    }
}

/// Whether `key` is one of the browser-preference settings the render
/// layer caches, so `set_setting` knows when to refresh it.
pub fn is_browser_setting_key(key: &str) -> bool {
    key == CHOICE_KEY || key == CUSTOM_PATH_KEY
}

/// The cached preference: (choice, custom path or none). A poisoned lock
/// means the render would panic on every print, so it is a panic — but the
/// guard is held only for the copy, so the only realistic cause is a bug
/// in this module.
static CHOICE: std::sync::Mutex<(BrowserChoice, Option<String>)> =
    std::sync::Mutex::new((BrowserChoice::Auto, None));

/// Replace the cached preference. Callers: app setup, the `set_setting`
/// command (for the two keys), and the reset command.
pub fn set_choice(choice: BrowserChoice, custom_path: Option<String>) {
    let mut guard = CHOICE.lock().unwrap();
    *guard = (choice, custom_path);
}

/// The current preference.
pub fn current_choice() -> (BrowserChoice, Option<String>) {
    CHOICE.lock().unwrap().clone()
}

/// Refresh the cache from the settings table. Empty custom paths are
/// treated as unset so a cleared input cannot fail every render.
pub fn apply_from(conn: &rusqlite::Connection) {
    let read = |key: &str| -> Option<String> {
        conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get::<_, String>(0)
        })
        .ok()
    };
    let choice = read(CHOICE_KEY)
        .map(|v| BrowserChoice::parse(&v))
        .unwrap_or_default();
    let custom = read(CUSTOM_PATH_KEY).filter(|v| !v.trim().is_empty());
    set_choice(choice, custom);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_maps_known_values_and_degrades_the_rest_to_auto() {
        assert_eq!(BrowserChoice::parse("auto"), BrowserChoice::Auto);
        assert_eq!(BrowserChoice::parse("SYSTEM"), BrowserChoice::System);
        assert_eq!(BrowserChoice::parse("edge"), BrowserChoice::System);
        assert_eq!(BrowserChoice::parse(" shell "), BrowserChoice::Shell);
        assert_eq!(BrowserChoice::parse("custom"), BrowserChoice::Custom);
        // Unknown/legacy/typo: the safe default, never a hard failure.
        assert_eq!(BrowserChoice::parse(""), BrowserChoice::Auto);
        assert_eq!(BrowserChoice::parse("bogus"), BrowserChoice::Auto);
        assert_eq!(BrowserChoice::parse("  "), BrowserChoice::Auto);
    }

    #[test]
    fn as_str_round_trips_through_parse() {
        for c in [
            BrowserChoice::Auto,
            BrowserChoice::System,
            BrowserChoice::Shell,
            BrowserChoice::Custom,
        ] {
            assert_eq!(BrowserChoice::parse(c.as_str()), c);
        }
    }

    #[test]
    fn set_and_current_choice_round_trip() {
        let before = current_choice();
        set_choice(BrowserChoice::Shell, Some("/tmp/shell".into()));
        assert_eq!(
            current_choice(),
            (BrowserChoice::Shell, Some("/tmp/shell".into()))
        );
        set_choice(BrowserChoice::Custom, None);
        assert_eq!(current_choice(), (BrowserChoice::Custom, None));
        // Restore: other tests in the binary share this process.
        set_choice(before.0, before.1.clone());
        assert_eq!(current_choice(), before);
    }
}
