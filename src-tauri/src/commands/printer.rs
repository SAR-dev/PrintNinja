use crate::db::DbState;
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

const VALID_PRINTER_TYPES: &[&str] = &["ipp", "raw_tcp", "usb", "bluetooth", "system"];
const VALID_LANGUAGES: &[&str] =
    &["pdf", "escpos", "tspl", "zpl", "cpcl", "raster"];

#[tauri::command]
pub fn list_printers(db: State<DbState>) -> AppResult<Vec<Printer>> {
    let guard = db.lock().map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;

    let mut stmt = conn.prepare(
        "SELECT id, name, type, address, language, paper_width_mm, dpi,
                default_settings_json, created_at, updated_at
         FROM printers ORDER BY name COLLATE NOCASE",
    )?;

    let printers = stmt
        .query_map([], |row| {
            Ok(Printer {
                id: row.get(0)?,
                name: row.get(1)?,
                printer_type: row.get(2)?,
                address: row.get(3)?,
                language: row.get(4)?,
                paper_width_mm: row.get(5)?,
                dpi: row.get(6)?,
                default_settings_json: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(printers)
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
pub fn add_printer(db: State<DbState>, req: AddPrinterRequest) -> AppResult<Printer> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("Printer name required".into()));
    }
    if !VALID_PRINTER_TYPES.contains(&req.printer_type.as_str()) {
        return Err(AppError::Validation(format!(
            "Invalid printer type '{}'. Expected one of {:?}",
            req.printer_type, VALID_PRINTER_TYPES
        )));
    }
    if !VALID_LANGUAGES.contains(&req.language.as_str()) {
        return Err(AppError::Validation(format!(
            "Invalid language '{}'. Expected one of {:?}",
            req.language, VALID_LANGUAGES
        )));
    }

    let guard = db.lock().map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;

    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM printers WHERE name = ?1 COLLATE NOCASE",
        [name],
        |r| r.get(0),
    )?;
    if exists > 0 {
        return Err(AppError::Validation(format!(
            "A printer named '{}' already exists",
            name
        )));
    }

    conn.execute(
        "INSERT INTO printers (name, type, address, language, paper_width_mm, dpi)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            name,
            req.printer_type,
            req.address,
            req.language,
            req.paper_width_mm,
            req.dpi,
        ],
    )?;

    let id = conn.last_insert_rowid();
    let printer = conn.query_row(
        "SELECT id, name, type, address, language, paper_width_mm, dpi,
                default_settings_json, created_at, updated_at
         FROM printers WHERE id = ?1",
        [id],
        |row| {
            Ok(Printer {
                id: row.get(0)?,
                name: row.get(1)?,
                printer_type: row.get(2)?,
                address: row.get(3)?,
                language: row.get(4)?,
                paper_width_mm: row.get(5)?,
                dpi: row.get(6)?,
                default_settings_json: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        },
    )?;

    Ok(printer)
}

#[tauri::command]
pub fn delete_printer(db: State<DbState>, id: i64) -> AppResult<()> {
    let guard = db.lock().map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;

    let affected = conn.execute("DELETE FROM printers WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Printer {} not found", id)));
    }
    Ok(())
}