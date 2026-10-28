//! App-log viewer support: read back what the size-rotated file
//! logging (see [`crate::logfile`]) recorded, for the Diagnostics
//! download. Bounded by [`crate::logfile::MAX_READ_BYTES`] so a huge
//! directory cannot turn into a huge IPC payload; per-call budgets are
//! additionally clamped below.

use tauri::AppHandle;

use crate::error::{AppError, AppResult};

/// Recent backend log text, oldest first, up to `max_kb` kilobytes
/// (default 256, clamped to 1 MiB). Empty when file logging never
/// started (stdout-only fallback) or nothing was recorded yet.
#[tauri::command]
pub async fn read_app_logs(app: AppHandle, max_kb: Option<u64>) -> AppResult<String> {
    use tauri::Manager;

    let budget = max_kb.unwrap_or(256).clamp(1, 1024) * 1024;
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| AppError::Internal(format!("no log directory: {e}")))?;
    Ok(crate::logfile::read_recent_logs(&dir, budget))
}
