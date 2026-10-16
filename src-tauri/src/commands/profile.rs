use crate::error::AppResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrinterProfile {
    pub id: i64,
    pub printer_id: i64,
    pub template_id: i64,
    pub settings_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
pub fn list_profiles() -> AppResult<Vec<PrinterProfile>> {
    Ok(vec![])
}

#[derive(Debug, Deserialize)]
pub struct SaveProfileRequest {
    pub printer_id: i64,
    pub template_id: i64,
    pub settings_json: String,
}

#[tauri::command]
pub fn save_profile(req: SaveProfileRequest) -> AppResult<PrinterProfile> {
    Ok(PrinterProfile {
        id: 0,
        printer_id: req.printer_id,
        template_id: req.template_id,
        settings_json: req.settings_json,
        created_at: String::new(),
        updated_at: String::new(),
    })
}

#[tauri::command]
pub fn delete_profile(id: i64) -> AppResult<()> {
    Ok(())
}
