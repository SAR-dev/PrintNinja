//! Opt-in download of Google's `chrome-headless-shell` — the Windows
//! fallback browser.
//!
//! Why it exists: recent Edge on Windows forwards a fresh headless
//! `msedge.exe` launch to an already-running Edge session ("handoff") and
//! exits 0 without producing a PDF. `chrome-headless-shell` is a
//! headless-only build of the same Chromium engine: no resident session
//! to hand off to, so it prints even while the user's Edge windows stay
//! open.
//!
//! Strictly opt-in: nothing is downloaded until the user presses the
//! download button in the UI (the browser notice or the print-repair
//! result). While the shell is installed, `find_edge` prefers it over
//! `msedge.exe`; the user can remove it any time and printing returns to
//! Edge.
//!
//! The version and the zip's SHA-256 are pinned as source constants
//! (puppeteer-revisions style): Chrome for Testing publishes no
//! per-version checksum file, and a hash fetched from the same server as
//! the bytes would prove nothing. To bump:
//! 1. pick a version from <https://googlechromelabs.github.io/chrome-for-testing/>
//! 2. download `https://storage.googleapis.com/chrome-for-testing-public/<ver>/win64/chrome-headless-shell-win64.zip`
//! 3. update [`SHELL_VERSION`] and [`SHELL_SHA256`] in this file.
//! Old installs sit in their own version directory and are simply
//! ignored (and removed) by the next install.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

// The download path and progress events exist only where the handoff
// failure does (Windows); on other platforms these traits go unused.
#[cfg(windows)]
use tauri::{Emitter, Manager};

/// Pinned chrome-headless-shell version (Chrome for Testing).
pub const SHELL_VERSION: &str = "157.0.8103.38";
/// SHA-256 of the pinned `chrome-headless-shell-win64.zip`, computed at
/// pin time and committed; a mismatched download is rejected.
pub const SHELL_SHA256: &str =
    "1ff4540855478ba0848e03f1ef8d455f77d058b38285df91bc34273788a73446";
/// Refuse downloads larger than this (the pinned zip is ~121 MiB; this
/// allows for growth across pinned versions while still catching a
/// hijacked response).
pub const SHELL_MAX_BYTES: u64 = 500 * 1024 * 1024;

/// Settings-table keys for the shell's device-local state. Never synced.
pub const STATE_KEY: &str = "browser-shell-state";
pub const ERROR_KEY: &str = "browser-shell-error";

/// Top-level directory inside the zip.
pub const ZIP_DIR_NAME: &str = "chrome-headless-shell-win64";
/// The executable inside that directory.
pub const EXE_NAME: &str = "chrome-headless-shell.exe";
/// The app-data root that holds one directory per pinned version.
pub const SHELL_ROOT_DIR: &str = "chrome-headless-shell";

/// Where the shell installs, under the app data dir:
/// `<app-data>/chrome-headless-shell/<SHELL_VERSION>`.
pub fn install_dir(app_data: &Path) -> PathBuf {
    app_data.join(SHELL_ROOT_DIR).join(SHELL_VERSION)
}

/// The app-data root holding all version directories (the removal unit).
pub fn shell_root(app_data: &Path) -> PathBuf {
    app_data.join(SHELL_ROOT_DIR)
}

/// The executable once extracted.
pub fn exe_path(app_data: &Path) -> PathBuf {
    install_dir(app_data).join(ZIP_DIR_NAME).join(EXE_NAME)
}

/// The pinned zip on the Chrome for Testing bucket.
pub fn zip_url() -> String {
    format!(
        "https://storage.googleapis.com/chrome-for-testing-public/{SHELL_VERSION}/win64/chrome-headless-shell-win64.zip"
    )
}

/// Hex SHA-256 of `data` (lowercase, matching [`SHELL_SHA256`]).
pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Progress event payload, emitted as `"browser-shell-progress"`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BrowserShellProgress {
    pub done: u64,
    pub total: u64,
}

/// Device-local status for the UI (read from the settings table plus the
/// filesystem, which is the source of truth for what actually works).
#[derive(Debug, Clone, serde::Serialize)]
pub struct BrowserShellStatus {
    /// `absent` (never downloaded) | `downloading` | `ready` | `error`.
    pub state: String,
    pub version: String,
    /// The installed executable, when ready.
    pub path: Option<String>,
    /// The last failure, when state is `error`.
    pub error: Option<String>,
}

/// The app data dir, captured once at startup.
///
/// Deliberately a plain `PathBuf`, not a `tauri::AppHandle`: `find_edge`
/// runs in binaries that must not pull the Tauri windowing stack in
/// (integration test executables carry no comctl32-v6 manifest, and a
/// linked `AppHandle` drags in wry — whose `SetWindowSubclass` import
/// then makes the loader abort with 0xc0000139 before main runs).
#[cfg(windows)]
static APP_DATA: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

#[cfg(windows)]
pub fn register_app(app: &tauri::AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = APP_DATA.set(dir);
    }
}

/// The downloaded shell, when it is on disk: `find_edge` prefers it over
/// `msedge.exe` so a running Edge session can no longer take the launch.
/// Filesystem check only (no DB round trip — this runs on every render):
/// the versioned path means a bumped pin self-heals, and a deleted file
/// simply stops being offered.
#[cfg(windows)]
pub fn ready_path() -> Option<PathBuf> {
    let app_data = APP_DATA.get()?;
    let exe = exe_path(app_data);
    exe.is_file().then_some(exe)
}

/// Download the pinned zip, verify its SHA-256 and extract it into
/// [`install_dir`]. Emits coarse `"browser-shell-progress"` events.
///
/// Windows only: the rest of the platform set has package managers and
/// the `PRINTNINJA_*_BIN` overrides, and the handoff failure that makes
/// the shell worth downloading is an Edge-on-Windows symptom.
#[cfg(windows)]
pub async fn download_and_install(app: &tauri::AppHandle) -> anyhow::Result<()> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("no app data dir: {e}"))?;
    let dir = install_dir(&app_data);
    tokio::fs::create_dir_all(&dir).await?;
    let zip_tmp = dir.join("download.tmp.zip");

    // Download, hashing as it streams; refuse anything oversized.
    let client = reqwest::Client::builder().build()?;
    let resp = client.get(zip_url()).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("download failed (HTTP {})", resp.status());
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&zip_tmp).await?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut stream = resp.bytes_stream();
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        received = received
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| anyhow::anyhow!("download size overflow"))?;
        if received > SHELL_MAX_BYTES {
            anyhow::bail!("download exceeds the {SHELL_MAX_BYTES}-byte safety limit");
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        if last_emit.elapsed() >= std::time::Duration::from_millis(250) {
            last_emit = std::time::Instant::now();
            let _ = app.emit(
                "browser-shell-progress",
                BrowserShellProgress {
                    done: received,
                    total,
                },
            );
        }
    }
    file.flush().await?;
    let digest = hex::encode(hasher.finalize());
    if digest != SHELL_SHA256 {
        let _ = tokio::fs::remove_file(&zip_tmp).await;
        anyhow::bail!(
            "SHA-256 mismatch (expected {SHELL_SHA256}, got {digest}) — \
             the download was rejected and removed"
        );
    }

    // Extract on a worker thread (zip parsing is blocking).
    let zip_path = zip_tmp.clone();
    let out = dir.clone();
    tokio::task::spawn_blocking(move || extract_zip(&zip_path, &out))
        .await
        .map_err(|e| anyhow::anyhow!("extraction task failed: {e}"))?
        .map_err(|e| anyhow::anyhow!("could not extract the download: {e}"))?;
    let _ = tokio::fs::remove_file(&zip_tmp).await;

    let exe = exe_path(&app_data);
    if !exe.is_file() {
        anyhow::bail!("extraction finished but {} is missing", exe.display());
    }
    Ok(())
}

/// Extract `zip_path` into `dest`. The zip carries one top-level
/// directory (`chrome-headless-shell-win64/`); it is replaced wholesale
/// so a partial earlier extraction cannot leave a mix of versions. The
/// `zip` crate refuses entries that would write outside `dest`.
#[cfg(windows)]
fn extract_zip(zip_path: &Path, dest: &Path) -> std::io::Result<()> {
    let inner = dest.join(ZIP_DIR_NAME);
    if inner.exists() {
        std::fs::remove_dir_all(&inner)?;
    }
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string())
    })?;
    archive
        .extract(dest)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_follow_the_versioned_layout() {
        let app_data = Path::new("/data/app");
        assert_eq!(
            install_dir(app_data),
            PathBuf::from(format!("/data/app/{SHELL_ROOT_DIR}/{SHELL_VERSION}"))
        );
        assert_eq!(
            exe_path(app_data),
            PathBuf::from(format!(
                "/data/app/{SHELL_ROOT_DIR}/{SHELL_VERSION}/{ZIP_DIR_NAME}/{EXE_NAME}"
            ))
        );
        assert_eq!(
            shell_root(app_data),
            PathBuf::from(format!("/data/app/{SHELL_ROOT_DIR}"))
        );
    }

    #[test]
    fn zip_url_uses_the_pinned_version() {
        assert_eq!(
            zip_url(),
            format!(
                "https://storage.googleapis.com/chrome-for-testing-public/{SHELL_VERSION}/win64/chrome-headless-shell-win64.zip"
            )
        );
    }

    #[test]
    fn sha256_is_lowercase_hex_of_the_digest() {
        // "abc" — known digest.
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn the_pinned_sha256_is_well_formed() {
        assert_eq!(SHELL_SHA256.len(), 64);
        assert!(SHELL_SHA256.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(SHELL_SHA256 == SHELL_SHA256.to_lowercase());
    }
}
