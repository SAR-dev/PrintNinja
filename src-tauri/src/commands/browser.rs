//! The opt-in headless browser (`chrome-headless-shell`): status,
//! download, remove.
//!
//! The bytes are the business of `render::browser_download` (URL, pin,
//! SHA-256, extraction). This module owns the device-local state rows in
//! the settings table — `browser-shell-state`
//! (`downloading` | `ready` | `error`; no row = `absent`) and
//! `browser-shell-error` (the last failure, shown in the UI) — plus the
//! Tauri wrappers. Nothing is downloaded silently: every byte arrives
//! after the user presses a button.

use crate::db::DbState;
use crate::error::{AppError, AppResult};
use crate::render::browser_download::{self, BrowserShellStatus};
use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};

fn lock_db<'a>(
    db: &'a State<'a, DbState>,
) -> AppResult<std::sync::MutexGuard<'a, crate::db::Database>> {
    db.lock()
        .map_err(|_| AppError::Internal("DB lock poisoned".into()))
}

fn set_state(conn: &Connection, state: &str) {
    let _ = conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![browser_download::STATE_KEY, state],
    );
}

fn set_error(conn: &Connection, message: &str) {
    let _ = conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![browser_download::ERROR_KEY, message],
    );
}

fn clear_error(conn: &Connection) {
    let _ = conn.execute(
        "DELETE FROM settings WHERE key = ?",
        [browser_download::ERROR_KEY],
    );
}

fn read_state(conn: &Connection) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?",
        [browser_download::STATE_KEY],
        |r| r.get(0),
    )
    .ok()
}

fn read_error(conn: &Connection) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?",
        [browser_download::ERROR_KEY],
        |r| r.get(0),
    )
    .ok()
}

fn exe_on_disk(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|app_data| browser_download::exe_path(&app_data))
}

/// Status for the UI. The disk is the source of truth for what works, so
/// a `ready` row without the file reports `absent` and the reverse is
/// healed back to `ready` (a crash between the extraction and the state
/// row must not strand a working install).
#[tauri::command(rename_all = "snake_case")]
pub async fn browser_shell_status(
    app: AppHandle,
    db: State<'_, DbState>,
) -> AppResult<BrowserShellStatus> {
    let guard = lock_db(&db)?;
    let conn = guard.connection();
    let exe = exe_on_disk(&app);
    let on_disk = exe.as_ref().is_some_and(|p| p.is_file());
    let mut state = read_state(conn).unwrap_or_else(|| "absent".to_string());
    if on_disk && state != "ready" {
        state = "ready".to_string();
        set_state(conn, "ready");
    }
    if !on_disk && state == "ready" {
        state = "absent".to_string();
        set_state(conn, "absent");
        clear_error(conn);
    }
    Ok(BrowserShellStatus {
        path: exe.filter(|p| p.is_file()).map(|p| p.display().to_string()),
        error: (state == "error").then(|| read_error(conn)).flatten(),
        state,
        version: browser_download::SHELL_VERSION.to_string(),
    })
}

/// Download, verify (SHA-256) and install the pinned shell. Progress
/// arrives as `"browser-shell-progress"` events; the state row is set to
/// `ready` only when everything succeeded.
#[tauri::command(rename_all = "snake_case")]
pub async fn browser_shell_download(app: AppHandle, db: State<'_, DbState>) -> AppResult<()> {
    {
        let guard = lock_db(&db)?;
        set_state(guard.connection(), "downloading");
        clear_error(guard.connection());
    }
    let result = browser_download::download_and_install(&app).await;
    {
        let guard = lock_db(&db)?;
        let conn = guard.connection();
        match &result {
            Ok(()) => {
                set_state(conn, "ready");
                clear_error(conn);
            }
            Err(e) => {
                set_state(conn, "error");
                set_error(conn, &e.to_string());
            }
        }
    }
    result.map_err(|e| AppError::Internal(e.to_string()))
}

/// Remove the installed shell (all version directories) and its state
/// rows: the opt-out. Printing returns to `msedge.exe`.
#[tauri::command(rename_all = "snake_case")]
pub async fn browser_shell_remove(app: AppHandle, db: State<'_, DbState>) -> AppResult<()> {
    // The whole root, not one version dir, so bumped versions do not
    // linger.
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Internal(format!("no app data dir: {e}")))?
        .join(browser_download::SHELL_ROOT_DIR);
    if root.exists() {
        tokio::fs::remove_dir_all(&root)
            .await
            .map_err(|e| AppError::Internal(format!("could not remove the browser: {e}")))?;
    }
    let guard = lock_db(&db)?;
    let conn = guard.connection();
    let _ = conn.execute(
        "DELETE FROM settings WHERE key = ?",
        [browser_download::STATE_KEY],
    );
    clear_error(conn);
    Ok(())
}

/// Call once from app setup: a `downloading` row can only be stale
/// (the download process is gone — the app restarted), so report it
/// honestly instead of leaving an in-progress bar behind. A `ready` row
/// whose file survived heals itself in [`browser_shell_status`]; this
/// covers the rest.
#[cfg(windows)]
pub fn heal_stale_download(app: &AppHandle, conn: &Connection) {
    let Some(state) = read_state(conn) else {
        return;
    };
    if state != "downloading" {
        return;
    }
    if exe_on_disk(app).is_some_and(|p| p.is_file()) {
        set_state(conn, "ready");
        clear_error(conn);
    } else {
        set_state(conn, "error");
        set_error(
            conn,
            "the download was interrupted by an app restart — download again",
        );
    }
}
