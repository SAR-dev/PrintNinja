use crate::error::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Batch {
    pub id: i64,
    pub template_id: Option<i64>,
    pub printer_id: Option<i64>,
    pub total: i64,
    pub done: i64,
    pub failed: i64,
    pub mode: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateBatchRequest {
    pub template_id: i64,
    pub printer_id: i64,
    pub data: serde_json::Value,
    pub mode: String,
    pub settings_json: Option<String>,
}

#[tauri::command]
pub fn create_batch(req: CreateBatchRequest) -> AppResult<Batch> {
    let records = req.data.as_array().map(|a| a.len() as i64).unwrap_or(0);
    Ok(Batch {
        id: 0,
        template_id: Some(req.template_id),
        printer_id: Some(req.printer_id),
        total: records,
        done: 0,
        failed: 0,
        mode: req.mode,
        status: "queued".to_string(),
        created_at: String::new(),
    })
}

#[tauri::command]
pub fn list_batches() -> AppResult<Vec<Batch>> {
    Ok(vec![])
}

#[tauri::command]
pub fn get_batch(id: i64) -> AppResult<Batch> {
    Err(crate::error::AppError::NotFound(format!("Batch {} not found", id)))
}

#[tauri::command]
pub fn cancel_batch(id: i64) -> AppResult<()> {
    Ok(())
}

#[tauri::command]
pub fn retry_batch(id: i64) -> AppResult<()> {
    Ok(())
}
