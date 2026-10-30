//! Whether the browser the renderer needs is installed (see
//! `render::render_engine_status`). Read-only and cheap: a few `exists()`
//! checks, so the UI can poll it after the user installs a browser.

use crate::render::{render_engine_status, RenderEngineStatus};

#[tauri::command]
pub fn get_render_engine_status() -> RenderEngineStatus {
    render_engine_status()
}
