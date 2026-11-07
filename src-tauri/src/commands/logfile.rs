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
#[tauri::command(rename_all = "snake_case")]
pub async fn read_app_logs(app: AppHandle, max_kb: Option<u64>) -> AppResult<String> {
    use tauri::Manager;

    let budget = max_kb.unwrap_or(256).clamp(1, 1024) * 1024;
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| AppError::Internal(format!("no log directory: {e}")))?;
    Ok(crate::logfile::read_recent_logs(&dir, budget))
}

/// Errors raised inside the webview (uncaught exceptions, unhandled
/// promise rejections) never reach the Rust log by themselves. The
/// frontend forwards them here so Diagnostics shows them too.
/// Bounded: text is truncated and the count capped per run, so a loop
/// of errors cannot flood the log.
#[tauri::command(rename_all = "snake_case")]
pub fn log_frontend_error(source: String, message: String) {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNT: AtomicU32 = AtomicU32::new(0);
    const MAX_PER_RUN: u32 = 200;

    if COUNT.fetch_add(1, Ordering::Relaxed) >= MAX_PER_RUN {
        return;
    }
    let source: String = source.chars().take(64).collect();
    let message: String = message.chars().take(4000).collect();
    tracing::error!(target: "frontend", source = %source, "{message}");
}
