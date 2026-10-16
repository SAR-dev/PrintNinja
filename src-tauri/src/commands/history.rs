use crate::error::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrintJob {
    pub id: i64,
    pub batch_id: Option<i64>,
    pub record_index: Option<i64>,
    pub template_id: Option<i64>,
    pub template_version_id: Option<i64>,
    pub printer_id: Option<i64>,
    pub source: String,
    pub source_url: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub copies: i64,
    pub settings_json: Option<String>,
    pub rendered_html: Option<String>,
    pub idempotency_key: Option<String>,
    pub is_test: bool,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
}

#[tauri::command]
pub fn list_jobs() -> AppResult<Vec<PrintJob>> {
    // TODO: Query from database
    Ok(vec![])
}

#[tauri::command]
pub fn get_job(id: i64) -> AppResult<PrintJob> {
    // TODO: Query from database
    Err(crate::error::AppError::NotFound(format!("Job {} not found", id)))
}

#[tauri::command]
pub fn reprint_job(id: i64) -> AppResult<PrintJob> {
    // TODO: Fetch original job and re-queue
    Err(crate::error::AppError::NotFound(format!("Job {} not found", id)))
}

#[tauri::command]
pub fn retry_job(id: i64) -> AppResult<PrintJob> {
    // TODO: Re-queue failed job
    Err(crate::error::AppError::NotFound(format!("Job {} not found", id)))
}

#[tauri::command]
pub fn delete_job(id: i64) -> AppResult<()> {
    // TODO: Delete from database
    Ok(())
}
