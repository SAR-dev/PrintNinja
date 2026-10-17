use crate::db::DbState;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Template {
    pub id: i64,
    pub name: String,
    pub current_version_id: Option<i64>,
    pub page_w_mm: i64,
    pub page_h_mm: i64,
    pub orientation: String,
    pub created_at: String,
    pub updated_at: String,
}

const VALID_ORIENTATIONS: &[&str] = &["portrait", "landscape"];

#[tauri::command]
pub fn list_templates(db: State<DbState>) -> AppResult<Vec<Template>> {
    let guard = db.lock().map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;

    let mut stmt = conn.prepare(
        "SELECT id, name, current_version_id, page_w_mm, page_h_mm,
                orientation, created_at, updated_at
         FROM templates ORDER BY name COLLATE NOCASE",
    )?;

    let templates = stmt
        .query_map([], |row| {
            Ok(Template {
                id: row.get(0)?,
                name: row.get(1)?,
                current_version_id: row.get(2)?,
                page_w_mm: row.get(3)?,
                page_h_mm: row.get(4)?,
                orientation: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(templates)
}

#[derive(Debug, Deserialize)]
pub struct CreateTemplateRequest {
    pub name: String,
    pub page_w_mm: Option<i64>,
    pub page_h_mm: Option<i64>,
    pub orientation: Option<String>,
    pub html: Option<String>,
    pub css: Option<String>,
}

#[tauri::command]
pub fn create_template(db: State<DbState>, req: CreateTemplateRequest) -> AppResult<Template> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("Template name required".into()));
    }

    let orientation = req.orientation.unwrap_or_else(|| "portrait".to_string());
    if !VALID_ORIENTATIONS.contains(&orientation.as_str()) {
        return Err(AppError::Validation(format!(
            "Invalid orientation '{}'. Expected one of {:?}",
            orientation, VALID_ORIENTATIONS
        )));
    }

    let page_w_mm = req.page_w_mm.unwrap_or(210);
    let page_h_mm = req.page_h_mm.unwrap_or(297);
    if page_w_mm <= 0 || page_h_mm <= 0 {
        return Err(AppError::Validation(
            "Page dimensions must be positive".into(),
        ));
    }

    let guard = db.lock().map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let mut conn = guard.connection()?;
    let tx = conn.transaction()?;

    let exists: i64 = tx.query_row(
        "SELECT COUNT(*) FROM templates WHERE name = ?1 COLLATE NOCASE",
        [name],
        |r| r.get(0),
    )?;
    if exists > 0 {
        return Err(AppError::Validation(format!(
            "A template named '{}' already exists",
            name
        )));
    }

    tx.execute(
        "INSERT INTO templates (name, page_w_mm, page_h_mm, orientation)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![name, page_w_mm, page_h_mm, orientation],
    )?;
    let template_id = tx.last_insert_rowid();

    // Create version 1 so `current_version_id` always points somewhere.
    tx.execute(
        "INSERT INTO template_versions (template_id, version_no, html, css, created_by)
         VALUES (?1, 1, ?2, ?3, 'manual')",
        rusqlite::params![
            template_id,
            req.html.clone().unwrap_or_default(),
            req.css.clone().unwrap_or_default(),
        ],
    )?;
    let version_id = tx.last_insert_rowid();

    tx.execute(
        "UPDATE templates SET current_version_id = ?1 WHERE id = ?2",
        rusqlite::params![version_id, template_id],
    )?;

    tx.commit()?;

    let template = tx_guard_to_template(&mut conn, template_id)?;
    Ok(template)
}

fn tx_guard_to_template(
    conn: &rusqlite::Connection,
    id: i64,
) -> rusqlite::Result<Template> {
    conn.query_row(
        "SELECT id, name, current_version_id, page_w_mm, page_h_mm,
                orientation, created_at, updated_at
         FROM templates WHERE id = ?1",
        [id],
        |row| {
            Ok(Template {
                id: row.get(0)?,
                name: row.get(1)?,
                current_version_id: row.get(2)?,
                page_w_mm: row.get(3)?,
                page_h_mm: row.get(4)?,
                orientation: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        },
    )
}

#[tauri::command]
pub fn delete_template(db: State<DbState>, id: i64) -> AppResult<()> {
    let guard = db.lock().map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;

    let affected = conn.execute("DELETE FROM templates WHERE id = ?1", [id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("Template {} not found", id)));
    }
    Ok(())
}