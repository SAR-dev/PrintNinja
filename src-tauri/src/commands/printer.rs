use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Printer {
    pub id: i64,
    pub name: String,
    pub printer_type: String,
    pub address: String,
    pub language: String,
    pub paper_width_mm: Option<i64>,
    pub dpi: Option<i64>,
    pub default_settings_json: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
pub fn list_printers() -> AppResult<Vec<Printer>> {
    // TODO: Query from database
    Ok(vec![])
}

#[derive(Debug, Deserialize)]
pub struct AddPrinterRequest {
    pub name: String,
    pub printer_type: String,
    pub address: String,
    pub language: String,
    pub paper_width_mm: Option<i64>,
    pub dpi: Option<i64>,
}

#[tauri::command]
pub fn add_printer(req: AddPrinterRequest) -> AppResult<Printer> {
    // TODO: Insert into database
    Ok(Printer {
        id: 0,
        name: req.name,
        printer_type: req.printer_type,
        address: req.address,
        language: req.language,
        paper_width_mm: req.paper_width_mm,
        dpi: req.dpi,
        default_settings_json: None,
        created_at: String::new(),
        updated_at: String::new(),
    })
}

#[tauri::command]
pub fn delete_printer(id: i64) -> AppResult<()> {
    // TODO: Delete from database
    Ok(())
}
