//! Opt-in download of Google's `chrome-headless-shell` — the fallback
//! browser for when the system one will not print.
//!
//! Why it exists: recent Edge on Windows forwards a fresh headless
//! `msedge.exe` launch to an already-running Edge session ("handoff") and
//! exits 0 without producing a PDF; Linux has no bundled browser at all
//! (the AppImage carries none). `chrome-headless-shell` is a headless-only
//! build of the same Chromium engine: no resident session to hand off to,
//! so it prints even while the user's Edge windows stay open.
//!
//! Strictly opt-in: nothing is downloaded until the user presses the
//! download button in the UI. While the shell is installed, the automatic
//! browser choice prefers it over the system browser; the user can remove
//! it any time and printing returns to the system browser.
//!
//! The version and the zip's SHA-256 are pinned as source constants
//! (puppeteer-revisions style): Chrome for Testing publishes no
//! per-version checksum file, and a hash fetched from the same server as
//! the bytes would prove nothing. To bump:
//! 1. pick a version from <https://googlechromelabs.github.io/chrome-for-testing/>
//! 2. download `https://storage.googleapis.com/chrome-for-testing-public/<ver>/{win64|linux64}/chrome-headless-shell-{win64|linux64}.zip`
//! 3. update [`SHELL_VERSION`] and [`SHELL_SHA256`] in this file.
//! Old installs sit in their own version directory and are simply
//! ignored (and removed) by the next install.
//!
//! The Linux download is additionally gated to x86_64: Chrome for Testing
//! publishes no arm64 headless shell, and a non-running install would
//! poison the automatic choice (which trusts the disk).

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};

/// Pinned chrome-headless-shell version (Chrome for Testing).
pub const SHELL_VERSION: &str = "157.0.8103.38";
/// Refuse downloads larger than this (the pinned zips are ~120 MiB; this
/// allows for growth across pinned versions while still catching a
/// hijacked response).
pub const SHELL_MAX_BYTES: u64 = 500 * 1024 * 1024;

/// SHA-256 of the pinned `chrome-headless-shell-win64.zip`, computed at
/// pin time and committed; a mismatched download is rejected.
#[cfg(windows)]
pub const SHELL_SHA256: &str = "1ff4540855478ba0848e03f1ef8d455f77d058b38285df91bc34273788a73446";
/// SHA-256 of the pinned `chrome-headless-shell-linux64.zip`.
#[cfg(target_os = "linux")]
pub const SHELL_SHA256: &str = "deafffa74660b34853a4119c361fd427ac8c9fcb62db51ddb8a797cd83a4ba2d";

/// Platform segment of the Chrome for Testing bucket path.
#[cfg(windows)]
const PLATFORM: &str = "win64";
#[cfg(target_os = "linux")]
const PLATFORM: &str = "linux64";

/// Top-level directory inside the platform zip.
#[cfg(windows)]
pub const ZIP_DIR_NAME: &str = "chrome-headless-shell-win64";
#[cfg(target_os = "linux")]
pub const ZIP_DIR_NAME: &str = "chrome-headless-shell-linux64";
/// The executable inside that directory.
#[cfg(windows)]
pub const EXE_NAME: &str = "chrome-headless-shell.exe";
#[cfg(target_os = "linux")]
pub const EXE_NAME: &str = "chrome-headless-shell";
/// The app-data root that holds one directory per pinned version.
pub const SHELL_ROOT_DIR: &str = "chrome-headless-shell";

/// Settings-table keys for the shell's device-local state. Never synced.
pub const STATE_KEY: &str = "browser-shell-state";
pub const ERROR_KEY: &str = "browser-shell-error";

/// The exact message a cancelled download reports, so the command layer
/// can map it back to `absent` (a cancel is not a failure).
pub const CANCELLED_MESSAGE: &str = "download cancelled";

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
        "https://storage.googleapis.com/chrome-for-testing-public/{SHELL_VERSION}/{PLATFORM}/chrome-headless-shell-{PLATFORM}.zip"
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
/// and `find_chromium` run in binaries that must not pull the Tauri
/// windowing stack in (integration test executables carry no comctl32-v6
/// manifest, and a linked `AppHandle` drags in wry — whose
/// `SetWindowSubclass` import then makes the loader abort with 0xc0000139
/// before main runs).
static APP_DATA: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub fn register_app(app: &tauri::AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = APP_DATA.set(dir);
    }
}

/// The downloaded shell, when it is on disk: the automatic browser choice
/// prefers it over the system browser. Filesystem check only (no DB round
/// trip — this runs on every render): the versioned path means a bumped
/// pin self-heals, and a deleted file simply stops being offered.
pub fn ready_path() -> Option<PathBuf> {
    let app_data = APP_DATA.get()?;
    let exe = exe_path(app_data);
    exe.is_file().then_some(exe)
}

// ── Cancellation ─────────────────────────────────────────────────
// At most one download runs at a time (the UI disables the button while
// one is in flight), so a single slot is enough: the flag the active
// download checks on every received chunk, and a registry the remove and
// cancel commands consult.

static ACTIVE: std::sync::Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>> =
    std::sync::Mutex::new(None);

/// Clear the active-download slot when the download ends, whatever the
/// outcome. Unit struct: the flag itself lives in [`ACTIVE`], the guard
/// only owns the lifetime that ends the registration.
struct ActiveGuard;

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        *ACTIVE.lock().unwrap() = None;
    }
}

/// Ask the in-flight download to stop. Returns whether a download was
/// running (a cancel with nothing in flight is a no-op, not an error).
pub fn cancel_download() -> bool {
    let guard = ACTIVE.lock().unwrap();
    let Some(flag) = guard.as_ref() else {
        return false;
    };
    flag.store(true, std::sync::atomic::Ordering::Release);
    true
}

/// Wait for an in-flight download to finish (its guard clears the slot on
/// drop). Removal uses this so it never fights the writer for the
/// download files. Bounded: a wedged download should not hang the UI.
pub async fn wait_for_active_download() {
    for _ in 0..300 {
        if ACTIVE.lock().unwrap().is_none() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

/// Download the pinned zip, verify its SHA-256 and extract it into
/// [`install_dir`]. Emits coarse `"browser-shell-progress"` events.
///
/// On Linux the download is gated to x86_64 (Chrome for Testing publishes
/// no arm64 shell) and the extracted binary is run with `--version`
/// before the install counts as ready — a system missing Chromium's
/// shared libraries (notably `libnss3`) would otherwise get a file that
/// exists on disk but never runs, and the automatic choice trusts the
/// disk.
pub async fn download_and_install(app: &tauri::AppHandle) -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    if std::env::consts::ARCH != "x86_64" {
        anyhow::bail!(
            "the headless shell download is only available on 64-bit (x86_64) \
             Linux — Chrome for Testing publishes no shell for this \
             architecture; printing here uses the system browser \
             (apt install chromium or google-chrome)"
        );
    }

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("no app data dir: {e}"))?;
    let dir = install_dir(&app_data);
    tokio::fs::create_dir_all(&dir).await?;
    let zip_tmp = dir.join("download.tmp.zip");

    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    *ACTIVE.lock().unwrap() = Some(cancelled.clone());
    let _active = ActiveGuard;

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
        // Cancel: stop at the next chunk, drop the partial file.
        if cancelled.load(std::sync::atomic::Ordering::Acquire) {
            let _ = tokio::fs::remove_file(&zip_tmp).await;
            anyhow::bail!(CANCELLED_MESSAGE);
        }
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

    // Extract on a worker thread (zip parsing is blocking), then prove
    // the binary actually starts (see the module doc).
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
    let smoke = exe.clone();
    tokio::task::spawn_blocking(move || smoke_test(&smoke))
        .await
        .map_err(|e| anyhow::anyhow!("smoke test task failed: {e}"))?
        .map_err(|e| {
            // A shell that cannot start is worse than none: the automatic
            // choice trusts the disk, so remove the install with it.
            let _ = std::fs::remove_dir_all(install_dir(&app_data));
            #[cfg(target_os = "linux")]
            {
                anyhow::anyhow!(
                    "the downloaded browser could not be started ({e}) — this \
                     usually means the system is missing Chromium's shared \
                     libraries (on Debian/Ubuntu: `apt install libnss3` and \
                     the rest); the download was removed"
                )
            }
            #[cfg(not(target_os = "linux"))]
            {
                anyhow::anyhow!(
                    "the downloaded browser could not be started ({e}) — \
                     the download was removed"
                )
            }
        })?;
    Ok(())
}

/// Prove the extracted binary runs: `--version` prints the version and
/// exits 0 on a healthy install.
fn smoke_test(exe: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        // The zip's permission bits are not guaranteed to survive every
        // extraction; make the executable explicitly executable.
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(exe, std::fs::Permissions::from_mode(0o755));
    }
    let out = std::process::Command::new(exe)
        .arg("--version")
        .output()
        .map_err(|e| std::io::Error::new(e.kind(), format!("launch: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let detail = stderr
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("no stderr")
            .trim()
            .to_string();
        return Err(std::io::Error::other(format!(
            "exited {}; {detail}",
            out.status
        )));
    }
    Ok(())
}

/// Extract `zip_path` into `dest`. The zip carries one top-level
/// directory (`chrome-headless-shell-<platform>/`); it is replaced
/// wholesale so a partial earlier extraction cannot leave a mix of
/// versions. The `zip` crate refuses entries that would write outside
/// `dest`.
fn extract_zip(zip_path: &Path, dest: &Path) -> std::io::Result<()> {
    let inner = dest.join(ZIP_DIR_NAME);
    if inner.exists() {
        std::fs::remove_dir_all(&inner)?;
    }
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
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
    fn zip_url_uses_the_pinned_version_and_platform() {
        assert_eq!(
            zip_url(),
            format!(
                "https://storage.googleapis.com/chrome-for-testing-public/{SHELL_VERSION}/{PLATFORM}/chrome-headless-shell-{PLATFORM}.zip"
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

    #[test]
    fn cancel_is_a_no_op_without_a_download() {
        assert!(!cancel_download());
    }

    #[test]
    fn the_cancelled_message_is_a_stable_sentinel() {
        // commands::browser maps this exact message back to `absent`;
        // pin the value so a rename fails a test.
        assert_eq!(CANCELLED_MESSAGE, "download cancelled");
    }
}
