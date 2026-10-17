use crate::db::DbState;
use crate::error::{AppError, AppResult};
use tauri::State;

#[tauri::command]
pub fn get_setting(db: State<DbState>, key: String) -> AppResult<Option<String>> {
    let guard = db.lock().map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;

    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query([&key])?;

    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn set_setting(db: State<DbState>, key: String, value: String) -> AppResult<()> {
    if key.trim().is_empty() {
        return Err(AppError::Validation("Setting key required".into()));
    }

    let guard = db.lock().map_err(|_| AppError::Internal("DB lock poisoned".into()))?;
    let conn = guard.connection()?;

    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;

    Ok(())
}