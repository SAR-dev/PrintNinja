//! Whether this process is running elevated (as administrator).
//!
//! An elevated parent changes how headless Edge behaves: it exits 0 in a
//! few hundred milliseconds without printing, even on a fresh profile
//! (docs/architecture/RENDERING_AND_LAYOUT.md). The render path and the
//! repair need to
//! know that happened instead of guessing at "profile in use" or "a
//! running session took the launch".
//!
//! The check runs once, via the process token (`OpenProcessToken` +
//! `GetTokenInformation(TokenElevation)`), and is cached in a
//! [`OnceLock`]: elevation cannot change during a run, so the result is a
//! property of the process, not of a moment.
//!
//! Only kernel32/advapi32 imports. Deliberately `windows-sys`, not the
//! `windows` crate: this is the module the failure paths import, and it
//! must stay free of anything that could drag the comctl32-v6 manifest
//! (the wry/tao stack) into the manifest-less test executables.
//!
//! This module detects and explains; it deliberately does *not* make
//! printing work while elevated. Launching Edge de-elevated and
//! `--no-sandbox` when elevated were both considered and not built: the
//! owner decided PrintNinja does not need to run elevated,
//! so the right behavior is an actionable "restart normally" message.
//! WebView2 printing remains a longer-term option. See
//! docs/architecture/RENDERING_AND_LAYOUT.md.

#[cfg(windows)]
use std::sync::OnceLock;

/// The operator-facing wording for an elevated render failure, shared by
/// the render path, the persistent-browser launch and the repair so they
/// never disagree. The frontend maps any message starting with it to
/// `errors.edge_elevated` — keep the opening in sync with
/// `src/lib/errors.ts`.
#[cfg(windows)]
pub const ELEVATED_ERROR: &str = "PrintNinja is running as administrator — Edge will not print from an elevated process. Restart PrintNinja normally (without 'Run as administrator'), then try again.";

/// Whether the current process holds an elevated (administrator) token.
///
/// Windows only in practice: the failure this explains is an
/// Edge-on-Windows symptom. Every other platform reports `false` without
/// any token machinery. Production call sites are all `#[cfg(windows)]`;
/// the `test` keeps it alive for the cross-platform tests below.
#[cfg(any(windows, test))]
pub fn is_elevated() -> bool {
    #[cfg(windows)]
    {
        *ELEVATED.get_or_init(check)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
static ELEVATED: OnceLock<bool> = OnceLock::new();

#[cfg(windows)]
fn check() -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // SAFETY: `GetCurrentProcess` returns a pseudo-handle to this process
    // that must never be closed; the token handle is closed before return.
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut info = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut len = std::mem::size_of::<TOKEN_ELEVATION>() as u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            &mut info as *mut _ as *mut _,
            len,
            &mut len,
        ) != 0;
        CloseHandle(token);
        ok && info.TokenIsElevated != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The result is cached: the second call is cheap and must agree.
    #[test]
    fn elevation_is_cached_and_stable() {
        assert_eq!(is_elevated(), is_elevated());
    }

    /// Off-Windows there is no elevation to report.
    #[cfg(not(windows))]
    #[test]
    fn off_windows_the_process_is_not_elevated() {
        assert!(!is_elevated());
    }
}
