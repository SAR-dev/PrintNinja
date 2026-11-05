//! One-click repair for the Windows print pipeline (see `render::fix`).

use crate::error::{AppError, AppResult};
use crate::render::fix::FixReport;
use tauri::{AppHandle, Manager};

/// Close the running Edge (`close_edge` — the UI confirmed it), remove the
/// stale render profiles, reset the persistent-browser cooldown and prove
/// the pipeline with a test render. Returns a per-step report for the
/// settings page.
#[tauri::command(rename_all = "snake_case")]
pub async fn fix_pc_print(app: AppHandle, close_edge: bool) -> AppResult<FixReport> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Internal(format!("No cache dir: {e}")))?;
    crate::render::fix::run(&cache_dir, close_edge)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))
}
